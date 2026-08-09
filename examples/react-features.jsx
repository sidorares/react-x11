// The React feature set, running: priority, <Suspense>, optimistic state,
// <Activity> and error boundaries, one panel each, all of them things you
// drive by hand rather than read about. docs/react-features.md is the prose;
// this is the same claims with a slider on them.
// Run with: npm run examples:react-features  (needs an X server / DISPLAY)
//
// What to look for, panel by panel:
//
//   Priority    Drag the slider with "defer the field" off and the thumb
//               crawls behind the pointer: one setState renders the readout
//               *and* the thousand-cell Mandelbrot field in a single
//               uninterruptible pass, ~25ms of it, before anything reaches
//               the screen. Switch deferring on and the thumb and its number
//               come free of the field — same work, two priorities. The
//               counters are the evidence: thirty slider updates and one or
//               two field rebuilds, because React threw the renders in
//               between away rather than finishing work nobody would see.
//
//   Suspense    Pick a record with "load in a transition" off and the
//               fallback replaces the content every time. Turn it on and the
//               record you were reading stays on screen until the next one is
//               ready. Same boundary, same promise — what changed is which
//               update asked for it.
//
//   Optimistic  useOptimistic puts the new note on the list on the keystroke
//               and the real save lands a second later. Arm "make the next
//               save fail" and watch the note roll back out again.
//
//   Activity    Type into both copies, hide them, bring them back: the
//               unmounted one is empty, the <Activity> one is exactly where
//               you left it — with its timer stopped for the time it was
//               hidden, because hiding tears effects down but keeps state.
//
//   Errors      Three throws, three outcomes: caught by a boundary inside the
//               window, caught by one outside it (which takes the real X
//               window with it), and thrown from an event handler, where no
//               boundary can help and react-x11 reports it instead.
//
// Deliberately not wrapped in <StrictMode>: it is safe here (see
// docs/react-features.md), but double-rendering everything would double the
// numbers the Priority panel exists to show.
import React, {
  Activity,
  lazy,
  memo,
  Suspense,
  use,
  useCallback,
  useEffect,
  useDeferredValue,
  useOptimistic,
  useState,
  useSyncExternalStore,
  useTransition,
} from 'react';
import {
  Button,
  createRoot,
  createStyles,
  Slider,
  Switch,
  Tabs,
} from '../src/index.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const s = createStyles({
  window: { backgroundColor: '$surfaceHover' },
  shell: { flexGrow: 1, minHeight: 0 },
  panel: {
    flexGrow: 1,
    minHeight: 0,
    padding: 14,
    gap: 10,
    backgroundColor: '$background',
  },
  head: { fontSize: 16, color: '$text' },
  hint: { fontSize: 11, color: '$dim' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 0 },
  wrapRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  spacer: { flexGrow: 1 },
  label: { fontSize: 11, color: '$dim' },
  strong: { fontSize: 13, color: '$text' },
  // Pinned widths, not minWidths: a box the text cannot resize is what keeps
  // a changing number from relaying out the window. See the Priority panel.
  reading: { fontSize: 20, color: '$text', width: 62 },
  readingDim: { fontSize: 20, color: '$dim', width: 62 },
  counter: { fontSize: 11, color: '$dim', width: 118 },
  counterNarrow: { fontSize: 11, color: '$dim', width: 66 },
  counters: { fontSize: 11, color: '$dim', width: 460, height: 14 },
  light: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '$track',
    transition: { backgroundColor: 120 },
  },
  lightOn: { backgroundColor: '$accent' },
  badge: {
    fontSize: 10,
    color: '$accentText',
    backgroundColor: '$accent',
    paddingLeft: 6,
    paddingRight: 6,
    paddingTop: 2,
    paddingBottom: 2,
    borderRadius: 3,
  },
  card: {
    gap: 6,
    padding: 10,
    borderWidth: 1,
    borderColor: '$track',
    borderRadius: 4,
    backgroundColor: '$background',
  },
  cardHead: { fontSize: 13, color: '$text' },
  fieldWrap: {
    flexGrow: 1,
    minHeight: 0,
    padding: 2,
    borderWidth: 2,
    borderColor: '$track',
    borderRadius: 3,
  },
  fieldWrapStale: { borderColor: '$accent' },
  field: { flexGrow: 1, minHeight: 0, gap: 1 },
  fieldRow: { flexDirection: 'row', gap: 1, flexGrow: 1, flexBasis: 0 },
  cellText: { fontSize: 9, color: 'white' },
  column: { flexGrow: 1, flexBasis: 0, gap: 8, minWidth: 0 },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 8,
    paddingRight: 8,
    height: 26,
    borderRadius: 3,
    backgroundColor: '$surfaceHover',
  },
  input: {
    flexGrow: 1,
    padding: 6,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '$border',
    backgroundColor: '$background',
  },
  error: { fontSize: 12, color: '#c0392b' },
  skeletonLine: { height: 10, borderRadius: 3, backgroundColor: '$track' },
});

// ---------------------------------------------------------------------------
// Priority: one slider, two priorities
// ---------------------------------------------------------------------------

// 20 colours plus black for the interior, built once. A cell's style is then
// one of 21 hoisted objects rather than a fresh one per cell per render —
// styles here compare by value (docs/styling.md), so this saves allocation,
// not repaints.
const RAMP = Array.from({ length: 20 }, (_, i) => {
  const t = i / 19;
  const hex = (n) => Math.round(n).toString(16).padStart(2, '0');
  return `#${hex(30 + 200 * t)}${hex(60 + 110 * Math.sin(Math.PI * t))}${hex(190 - 130 * t)}`;
});
const CELL_STYLES = [...RAMP, '#101418'].map((backgroundColor) => ({
  flexGrow: 1,
  flexBasis: 0,
  backgroundColor,
}));
const INSIDE = CELL_STYLES.length - 1;

// The slider flies from the whole set into seahorse valley — the standard
// place to zoom, and the reason zooming makes the picture cost *more* rather
// than less: the points crowding the boundary are the ones that run the
// iteration all the way to its limit.
const TARGET = { x: -0.743643887037151, y: 0.13182590420533 };
const SPAN = 1.7;
// The field box is about this much wider than it is tall in the default
// window, and the view has to match it or the set comes out squashed. Nothing
// can measure the box during the render that fills it — there is no forced
// layout here (docs/react-features.md#measuring-a-node) — so this is the one
// number the panel assumes rather than reads.
const VIEW_ASPECT = 2.4;
const zoomAt = (value) => Math.pow(1 / 0.955, value);
const viewAt = (value) => ({
  x: -0.5 + (value / 100) * (TARGET.x + 0.5),
  y: (value / 100) * TARGET.y,
  scale: SPAN / zoomAt(value),
});

/**
 * The expensive subtree, and the work in it is real: the Mandelbrot set, one
 * cell per point, `limit` iterations before a point counts as inside. The
 * slider zooms, so every cell has to be recomputed for every value — there is
 * no incremental shortcut, which is what makes it a fair stand-in for the
 * derived data a real panel rebuilds.
 *
 * The two knobs are the two axes of expensive: `cells` is how much tree React
 * has to reconcile, `limit` is how much arithmetic each cell costs before it
 * produces an element. Only the second one can grow past a frame without
 * making layout and paint the bottleneck instead, and a render that outlasts
 * the gap between two pointer events is the whole point — that is the render
 * React gets to throw away.
 *
 * `memo` is not an optimisation here, it is the mechanism. `useDeferredValue`
 * renders this component's parent twice — once urgently with the old value,
 * once at transition priority with the new one — and the first of those two
 * renders only stays cheap if this subtree bails out. Drop the memo and the
 * field is rebuilt on the urgent pass as well, which is exactly the frozen
 * slider that deferring was supposed to fix.
 */
const Field = memo(function Field({ value, cols, rows, limit, onBuilt }) {
  const started = performance.now();
  const view = viewAt(value);
  const halfY = view.scale / VIEW_ASPECT;

  const out = [];
  for (let r = 0; r < rows; r++) {
    const cells = [];
    const cy = view.y + halfY * (1 - (2 * r) / (rows - 1));
    for (let c = 0; c < cols; c++) {
      const cx = view.x + view.scale * ((2 * c) / (cols - 1) - 1);
      let x = 0;
      let y = 0;
      let i = 0;
      while (i < limit && x * x + y * y < 4) {
        const next = x * x - y * y + cx;
        y = 2 * x * y + cy;
        x = next;
        i += 1;
      }
      // log-scaled into the ramp: escape counts are spread over orders of
      // magnitude, and a linear map paints all the structure in one colour
      const k =
        i >= limit
          ? INSIDE
          : Math.min(
              RAMP.length - 1,
              Math.floor((Math.log(i + 1) / Math.log(limit)) * RAMP.length),
            );
      cells.push(<box key={c} style={CELL_STYLES[k]} />);
    }
    out.push(
      <box key={r} style={s.fieldRow}>
        {cells}
      </box>,
    );
  }
  const took = performance.now() - started;

  // The count is taken here, inside the memo, rather than from a <Profiler>
  // around it: a Profiler reports every commit its subtree is *part of*,
  // bail-outs included, so it would say the field updated on all of them. An
  // effect with no dependency list runs after the commits where this
  // component really re-rendered, which is the number the panel is claiming.
  useEffect(() => {
    onBuilt(took);
  });

  return <box style={s.field}>{out}</box>;
});

export function PriorityPanel() {
  const [value, setValue] = useState(0);
  const [defer, setDefer] = useState(true);
  const [cols, setCols] = useState(48);
  const [limit, setLimit] = useState(16000);

  const deferred = useDeferredValue(value);
  // The switch is the whole demo: `value` renders the field in the same pass
  // as the slider, `deferred` renders it in a later, interruptible one.
  const shown = defer ? deferred : value;
  const stale = shown !== value;
  const rows = Math.round(cols * 0.55);

  // Counting a commit from inside a commit is a feedback loop unless the loop
  // is closed: each of these setStates re-renders the panel, and that render
  // has to reach the memo and stop there. It does — none of the field's props
  // changed — so the cost of a live counter is one bail-out and one small
  // repaint, and it is worth that to have the number keep up after the drag
  // ends rather than sit at whatever it read on the last slider update.
  const [{ updates, builds, ms }, setCounts] = useState({
    updates: 0,
    builds: 0,
    ms: 0,
  });
  useEffect(() => {
    setCounts((c) => ({ ...c, updates: c.updates + 1 }));
  }, [value]);
  // Stable identity, or the memo has a prop that changes on every render and
  // never bails out — the same trap as the border, one level down.
  const onBuilt = useCallback((took) => {
    setCounts((c) => ({ ...c, builds: c.builds + 1, ms: took }));
  }, []);
  const reset = () => setCounts({ updates: 0, builds: 0, ms: 0 });

  return (
    <box style={s.panel}>
      <text style={s.head}>Priority — one slider, two priorities</text>
      <text style={s.hint}>
        The slider zooms into the Mandelbrot set, and the readout beside it says
        how far. Drag with deferring off and the thumb and the number crawl
        along behind the pointer, because every one of those pointer events
        renders the whole field before anything reaches the screen. Turn
        deferring on and they come free of it. The arrow keys are worth a try
        too: X11 key events are urgent where pointer motion is not, so a held
        arrow is the harder case.
      </text>

      {/* Every <text> here that changes has its width pinned, and the "catching
          up" light is a box whose colour changes rather than a label that
          appears. Text whose measured width changes is a layout change, and a
          layout change repaints the whole window by definition — so a readout
          written the obvious way would make each of these frames cost more
          than the field does, in a panel about frames costing too much. */}
      <box style={s.row}>
        <text style={s.label}>zoom</text>
        <Slider
          min={0}
          max={100}
          value={value}
          onChange={(ev) => setValue(ev.value)}
          style={{ flexGrow: 1 }}
        />
        <text style={s.reading}>{`×${zoomAt(value).toFixed(1)}`}</text>
        <text style={s.label}>field</text>
        <text style={stale ? s.readingDim : s.reading}>
          {`×${zoomAt(shown).toFixed(1)}`}
        </text>
        <box style={[s.light, stale && s.lightOn]} />
        <text style={s.label}>catching up</text>
      </box>

      <box style={s.row}>
        <text style={s.label}>defer the field</text>
        <Switch checked={defer} onChange={(ev) => setDefer(ev.value)} />
        <text
          style={s.counter}
        >{`${cols}×${rows} = ${cols * rows} cells`}</text>
        <Slider
          min={12}
          max={64}
          value={cols}
          onChange={(ev) => setCols(ev.value)}
          style={{ width: 90 }}
        />
        <text style={s.counterNarrow}>{`limit ${limit / 1000}k`}</text>
        <Slider
          min={2000}
          max={120000}
          step={2000}
          value={limit}
          onChange={(ev) => setLimit(ev.value)}
          style={{ width: 90 }}
        />
        <box style={s.spacer} />
        <Button label="reset counters" onPress={reset} />
      </box>

      <text style={s.counters}>
        {`slider updates ${updates}  ·  field rebuilds ${builds}  ·  ` +
          `last rebuild ${ms.toFixed(1)}ms`}
      </text>

      {/* The "stale" border is on this wrapper rather than on <Field>, and
          that is not tidiness: `stale` flips on every urgent update, so a
          Field that took it as a prop would re-render on every one of them.
          The memo would never bail out and the panel would be exactly as slow
          as it is with deferring off — a one-line mistake, invisible by eye,
          which is what the rebuild counter is for. */}
      <box style={[s.fieldWrap, stale && s.fieldWrapStale]}>
        <Field
          value={shown}
          cols={cols}
          rows={rows}
          limit={limit}
          onBuilt={onBuilt}
        />
      </box>

      <text style={s.hint}>
        A transition buys back React work — building elements, diffing props.
        The layout and the paint still happen for every frame that commits, so
        what deferring really buys is that most of the values you drag through
        never commit at all.
      </text>
    </box>
  );
}

// ---------------------------------------------------------------------------
// Suspense: a fallback you asked for, and one you did not
// ---------------------------------------------------------------------------

const RECORDS = [
  {
    id: 'shape',
    name: 'SHAPE',
    year: 1989,
    blurb:
      'Non-rectangular windows: a region the server clips a window to, which is how a round clock has no corners.',
  },
  {
    id: 'render',
    name: 'RENDER',
    year: 2000,
    blurb:
      'Compositing, gradients and glyph rendering, server side. Everything react-x11 draws goes through it.',
  },
  {
    id: 'xfixes',
    name: 'XFIXES',
    year: 2003,
    blurb:
      'Regions as first-class server objects, cursor images, and selection-owner notifications.',
  },
  {
    id: 'composite',
    name: 'COMPOSITE',
    year: 2003,
    blurb:
      'Redirect a window into an offscreen pixmap and let something else decide how it reaches the screen.',
  },
];

const LOAD_MS = 800;

// `use(promise)` needs the *same* promise back on every render for a given
// input, or the component suspends on a new promise forever. A module-level
// cache keyed by what identifies the request is the whole trick; `generation`
// is in the key so "reload" can ask for the same record again.
const recordCache = new Map();
function loadRecord(id, generation) {
  const key = `${id}:${generation}`;
  let promise = recordCache.get(key);
  if (!promise) {
    promise = sleep(LOAD_MS).then(() => RECORDS.find((r) => r.id === id));
    recordCache.set(key, promise);
  }
  return promise;
}

function RecordView({ id, generation }) {
  const record = use(loadRecord(id, generation));
  return (
    <box style={[s.card, { height: 118, justifyContent: 'center' }]}>
      <text style={{ fontSize: 18, color: '$text' }}>{record.name}</text>
      <text style={s.label}>{`in X11 since ${record.year}`}</text>
      <text style={{ fontSize: 12, color: '$text' }}>{record.blurb}</text>
    </box>
  );
}

/**
 * The fallback is given the height of the thing it stands in for on purpose.
 * A suspended subtree gives up its space entirely, so a fallback that is
 * shorter than the content makes everything below it jump up and back down on
 * every load — the one layout consequence of <Suspense> that has no DOM
 * equivalent to fall back on.
 */
function RecordSkeleton() {
  return (
    <box style={[s.card, { height: 118, justifyContent: 'center', gap: 10 }]}>
      <text style={s.label}>loading…</text>
      <box style={[s.skeletonLine, { width: 120 }]} />
      <box style={[s.skeletonLine, { width: 260 }]} />
    </box>
  );
}

function AppendixBody() {
  return (
    <box style={s.card}>
      <text style={s.cardHead}>Appendix</text>
      <text style={s.hint}>
        DAMAGE (2007), XINPUT2 (2009), PRESENT (2013). Loaded on demand, and
        only once — React keeps what the lazy factory resolved to.
      </text>
    </box>
  );
}

// In an app this factory is `() => import('./appendix.jsx')` and that is the
// only difference: `lazy` is about when a module is evaluated, and a promise
// resolving to `{ default }` is what it wants either way. A single-file
// bundle inlines the import() and keeps the lazy evaluation — see
// docs/packaging.md.
const Appendix = lazy(() => sleep(900).then(() => ({ default: AppendixBody })));

export function SuspensePanel() {
  const [id, setId] = useState('shape');
  const [generation, setGeneration] = useState(0);
  const [asTransition, setAsTransition] = useState(true);
  const [showAppendix, setShowAppendix] = useState(false);
  const [pending, startTransition] = useTransition();

  // The same setState, at two priorities. Urgent: React has nothing to show
  // for the new id, so the boundary falls back. In a transition: React keeps
  // the last committed content on screen and tells you it is working.
  const run = (update) => (asTransition ? startTransition(update) : update());

  return (
    <box style={s.panel}>
      <text style={s.head}>Suspense — and the fallback you can avoid</text>
      <text style={s.hint}>
        {`Every record takes ${LOAD_MS}ms to load. With the switch off you see the ` +
          'fallback on every click; with it on you keep reading the record you had.'}
      </text>

      <box style={s.row}>
        {RECORDS.map((r) => (
          <Button
            key={r.id}
            primary={r.id === id}
            label={r.name}
            onPress={() => run(() => setId(r.id))}
          />
        ))}
        <box style={s.spacer} />
        {pending ? <text style={s.badge}>pending</text> : null}
      </box>

      <box style={s.row}>
        <text style={s.label}>load in a transition</text>
        <Switch
          checked={asTransition}
          onChange={(ev) => setAsTransition(ev.value)}
        />
        <Button
          label="reload this record"
          onPress={() => run(() => setGeneration((n) => n + 1))}
        />
      </box>

      <Suspense fallback={<RecordSkeleton />}>
        <RecordView id={id} generation={generation} />
      </Suspense>

      <box style={s.row}>
        <Button
          label="load the appendix"
          disabled={showAppendix}
          onPress={() => setShowAppendix(true)}
        />
        <text style={s.hint}>React.lazy, with its own boundary</text>
      </box>
      {showAppendix ? (
        <Suspense
          fallback={
            <box style={[s.card, { height: 62 }]}>
              <text style={s.label}>loading the appendix…</text>
            </box>
          }
        >
          <Appendix />
        </Suspense>
      ) : null}

      <box style={s.spacer} />
      <text style={s.hint}>
        A <text style={{ color: '$text' }}>{'<window>'}</text> inside a boundary
        is the case to avoid: hiding it unmaps the real X window, and the window
        manager treats the reveal as a brand new one. Suspend inside a window,
        not around it.
      </text>
    </box>
  );
}

// ---------------------------------------------------------------------------
// Optimistic: the answer before the outcome
// ---------------------------------------------------------------------------

const FIRST_NOTES = [
  { id: 1, text: 'claim the root window' },
  { id: 2, text: 'answer the map request' },
];

let nextNoteId = FIRST_NOTES.length + 1;

async function saveNote(note, shouldFail) {
  await sleep(1100);
  if (shouldFail) throw new Error('the server refused it');
  return note;
}

export function OptimisticPanel() {
  const [notes, setNotes] = useState(FIRST_NOTES);
  const [text, setText] = useState('');
  const [failNext, setFailNext] = useState(false);
  const [error, setError] = useState(null);
  const [pending, startTransition] = useTransition();
  // The reducer has to be idempotent, and that is worth knowing before it
  // bites: React keeps re-applying it on top of the newest state until the
  // transition ends, and the transition does not end until the async action
  // returns — which is *after* the action has already put the real note in
  // `notes`. Append blindly and the note is briefly in the list twice, with
  // the duplicate-key warning that goes with it.
  const [shown, addOptimistic] = useOptimistic(notes, (list, note) =>
    list.some((n) => n.id === note.id)
      ? list
      : [...list, { ...note, pending: true }],
  );

  const add = () => {
    const value = text.trim();
    if (!value) return;
    const note = { id: nextNoteId++, text: value };
    setText('');
    setError(null);
    // The optimistic entry only exists for the life of this transition:
    // React keeps it until the async function returns, then re-renders
    // against whatever `notes` has become — the saved note, or, if the save
    // threw, nothing at all. Rollback is not code you write.
    startTransition(async () => {
      addOptimistic(note);
      try {
        const saved = await saveNote(note, failNext);
        setNotes((list) => [...list, saved]);
      } catch (err) {
        setError(err.message);
      }
    });
  };

  return (
    <box style={s.panel}>
      <text style={s.head}>Optimistic — useOptimistic and an async action</text>
      <text style={s.hint}>
        The note appears on the press and the save takes a second. Nothing here
        polls, retries or reverts by hand.
      </text>

      <box style={s.row}>
        <textinput
          value={text}
          placeholder="a note"
          onChange={(ev) => setText(ev.target.value)}
          onSubmit={add}
          style={s.input}
        />
        <Button primary label="add" onPress={add} />
        {pending ? <text style={s.badge}>saving</text> : null}
      </box>

      <box style={s.row}>
        <text style={s.label}>make the next save fail</text>
        <Switch checked={failNext} onChange={(ev) => setFailNext(ev.value)} />
      </box>

      <box style={{ gap: 4 }}>
        {shown.map((note) => (
          <box key={note.id} style={s.listRow}>
            <text
              style={{ fontSize: 12, color: note.pending ? '$dim' : '$text' }}
            >
              {note.text}
            </text>
            <box style={s.spacer} />
            {note.pending ? <text style={s.label}>saving…</text> : null}
          </box>
        ))}
      </box>
      {error ? <text style={s.error}>{`rolled back — ${error}`}</text> : null}
    </box>
  );
}

// ---------------------------------------------------------------------------
// Activity: hidden, but still there
// ---------------------------------------------------------------------------

function Scratch({ title }) {
  const [count, setCount] = useState(0);
  const [text, setText] = useState('');
  const [ticks, setTicks] = useState(0);

  // An effect, so the difference between "unmounted" and "hidden" is visible
  // in both directions: <Activity mode="hidden"> keeps the state and tears
  // the effects down, so the timer stops while it is away and the count it
  // reached is still there when it comes back.
  useEffect(() => {
    const timer = setInterval(() => setTicks((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <box style={s.card}>
      <text style={s.cardHead}>{title}</text>
      <box style={s.row}>
        <Button label="+1" onPress={() => setCount((n) => n + 1)} />
        <text style={s.strong}>{`count ${count}`}</text>
      </box>
      <textinput
        value={text}
        placeholder="type something"
        onChange={(ev) => setText(ev.target.value)}
        style={s.input}
      />
      <text style={s.label}>{`${ticks}s of timer, while mounted`}</text>
    </box>
  );
}

export function ActivityPanel() {
  const [visible, setVisible] = useState(true);

  return (
    <box style={s.panel}>
      <text style={s.head}>Activity — hidden without being unmounted</text>
      <text style={s.hint}>
        Put a count and some text into both, hide them, wait a few seconds and
        bring them back. Only one of them remembers.
      </text>

      <box style={s.row}>
        <text style={s.label}>visible</text>
        <Switch checked={visible} onChange={(ev) => setVisible(ev.value)} />
        <text style={s.hint}>
          both columns give up their layout space when hidden — that part is the
          same
        </text>
      </box>

      <box style={[s.wrapRow, { alignItems: 'flex-start' }]}>
        <box style={s.column}>
          <text style={s.label}>{'{visible && <Scratch/>}'}</text>
          {visible ? <Scratch title="unmounted when hidden" /> : null}
        </box>
        <box style={s.column}>
          <text style={s.label}>{'<Activity mode=…>'}</text>
          {/* Known gap #202: hiding a subtree does not move focus out of it,
              so the input below keeps taking keystrokes while invisible. */}
          <Activity mode={visible ? 'visible' : 'hidden'}>
            <Scratch title="kept alive when hidden" />
          </Activity>
        </box>
      </box>

      <box style={s.spacer} />
      <text style={s.hint}>
        Around a toplevel {'<window>'} the same switch unmaps the window — one
        mounted hidden is never mapped at all, so the window manager first hears
        about it on the reveal.
      </text>
    </box>
  );
}

// ---------------------------------------------------------------------------
// Errors: where the boundary goes
// ---------------------------------------------------------------------------

/** The three-line external store this renderer recommends for anything that
 * lives outside React (docs/react-features.md#bridging-non-react-code). Two
 * of them here: what the root reported, and whether the detonator is armed. */
function makeStore(initial) {
  let value = initial;
  const subscribers = new Set();
  return {
    get: () => value,
    set(next) {
      value = next;
      for (const fn of subscribers) fn();
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
  };
}

const reportStore = makeStore([]);
const armedStore = makeStore(false);

/** `getSnapshot` has to return the same array until something changes, so
 * every report replaces the list rather than pushing onto it. */
export function report(kind, error) {
  const message = String(error?.message ?? error);
  reportStore.set([{ kind, message }, ...reportStore.get()].slice(0, 5));
}

const useReports = () =>
  useSyncExternalStore(reportStore.subscribe, reportStore.get);
const useArmed = () =>
  useSyncExternalStore(armedStore.subscribe, armedStore.get);

/**
 * A boundary, written out rather than imported, because the interesting part
 * of it here is not the class — it is where in the tree it goes.
 */
class Boundary extends React.Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return this.props.fallback(this.state.error, () => {
      this.props.onReset?.();
      this.setState({ error: null });
    });
  }
}

function Fragile({ broken }) {
  if (broken) throw new Error('Fragile threw while it was rendering');
  return <text style={s.hint}>Fragile is rendering normally.</text>;
}

/** Rendered inside <window> but outside every boundary in it, so the only
 * boundary that can catch it is the one wrapped around the window itself. */
function Detonator() {
  if (useArmed()) {
    throw new Error('a throw from inside <window>, caught outside it');
  }
  return null;
}

export function ErrorsPanel() {
  const [broken, setBroken] = useState(false);
  const reports = useReports();

  return (
    <box style={s.panel}>
      <text style={s.head}>Error boundaries — placement is the decision</text>

      <box style={s.card}>
        <text style={s.cardHead}>1 · a boundary inside the window</text>
        <text style={s.hint}>
          The throw is caught, this panel keeps rendering, and the X window —
          its position, size and stacking — is untouched. This is where a
          boundary belongs.
        </text>
        <Boundary
          onReset={() => setBroken(false)}
          fallback={(error, retry) => (
            <box style={s.row}>
              <text style={s.error}>{error.message}</text>
              <Button label="try again" onPress={retry} />
            </box>
          )}
        >
          <Fragile broken={broken} />
        </Boundary>
        <box style={s.row}>
          <Button label="throw during render" onPress={() => setBroken(true)} />
        </box>
      </box>

      <box style={s.card}>
        <text style={s.cardHead}>
          2 · the only boundary is outside the window
        </text>
        <text style={s.hint}>
          Move or resize this window first, then press. The window is destroyed
          and a fallback window takes its place; rebuilding gives you a new
          window, wherever the window manager decides to put it, and everything
          you did to the old one is gone.
        </text>
        <box style={s.row}>
          <Button
            label="destroy the window"
            onPress={() => armedStore.set(true)}
          />
        </box>
      </box>

      <box style={s.card}>
        <text style={s.cardHead}>3 · a throw from an event handler</text>
        <text style={s.hint}>
          No boundary can see this one: the handler ran from an X event, so
          React was never on the stack. react-x11 catches it at the dispatcher
          and hands it to the root — this example is one whose onUncaughtError
          writes to the list below, and dispatch carries on.
        </text>
        <box style={s.row}>
          <Button
            label="throw in onPress"
            onPress={() => {
              throw new Error('thrown from an onPress handler');
            }}
          />
        </box>
      </box>

      <text style={s.label}>what the root was told</text>
      <box style={{ gap: 4 }}>
        {reports.length === 0 ? (
          <text style={s.hint}>nothing reported yet</text>
        ) : (
          reports.map((r, i) => (
            <box key={i} style={s.listRow}>
              <text style={s.badge}>{r.kind}</text>
              <text style={{ fontSize: 12, color: '$text' }}>{r.message}</text>
            </box>
          ))
        )}
      </box>
    </box>
  );
}

// ---------------------------------------------------------------------------
// The shell
// ---------------------------------------------------------------------------

const SECTIONS = [
  { id: 'priority', label: 'Priority', content: () => <PriorityPanel /> },
  { id: 'suspense', label: 'Suspense', content: () => <SuspensePanel /> },
  { id: 'optimistic', label: 'Optimistic', content: () => <OptimisticPanel /> },
  { id: 'activity', label: 'Activity', content: () => <ActivityPanel /> },
  { id: 'errors', label: 'Errors', content: () => <ErrorsPanel /> },
];

// Which tab was open lives outside React on purpose: the window in demo 2 is
// destroyed and rebuilt, and a module variable is state that survives that
// where component state does not. The window's own geometry survives neither,
// which is the point being made over there.
let lastTab = SECTIONS[0].id;

/** The panels without a window round them, so this can be hosted elsewhere. */
export function ReactFeaturesPanel() {
  const [tab, setTab] = useState(lastTab);
  return (
    <Tabs
      items={SECTIONS}
      value={tab}
      onChange={(id) => {
        lastTab = id;
        setTab(id);
      }}
      style={s.shell}
    />
  );
}

function MainWindow({ width, height }) {
  return (
    <window
      title="react features"
      width={width}
      height={height}
      minWidth={640}
      minHeight={420}
      style={s.window}
    >
      <Detonator />
      <ReactFeaturesPanel />
    </window>
  );
}

/** The fallback for a boundary wrapping the window: it has to be a window
 * itself. There is no document to fall back into. */
function Rubble({ error, onRebuild }) {
  return (
    <window
      title="the window is gone"
      width={430}
      height={190}
      style={s.window}
    >
      <box style={s.panel}>
        <text style={s.head}>The window went with the error</text>
        <text style={s.error}>{error.message}</text>
        <text style={s.hint}>
          The boundary was outside {'<window>'}, so recovering meant unmounting
          the window: the X window was destroyed, and with it everything the
          window manager knew about it. Rebuilding makes a new one.
        </text>
        <box style={s.spacer} />
        <box style={s.row}>
          <Button primary label="rebuild the window" onPress={onRebuild} />
        </box>
      </box>
    </window>
  );
}

function App({ width = 900, height = 660 }) {
  return (
    <Boundary
      onReset={() => armedStore.set(false)}
      fallback={(error, retry) => <Rubble error={error} onRebuild={retry} />}
    >
      <MainWindow width={width} height={height} />
    </Boundary>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  // Both handlers are taken over so the Errors panel can show what the root
  // was told. The default onUncaughtError logs and sets a failing exit code,
  // which is right for an app and wrong for a demo whose whole job is to
  // throw on request.
  const root = await createRoot({
    onUncaughtError: (error) => report('uncaught', error),
    onCaughtError: (error) => report('caught', error),
  });
  root.render(<App />);
}

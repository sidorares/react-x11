// A font explorer — what fontconfig would give you, and what it looks like.
//
//   npm run examples:fonts
//   npm run examples:fonts -- ':lang=ja'      # start on a query
//
// Text is the largest thing this renderer does that a web developer never
// has to think about, and the place its bugs have hidden: a cap band rounded
// the wrong way (#327), a baseline taken from the ascent (#328), a field
// whose text does not mirror (#341). All of those passed a green test suite
// and were obvious the moment somebody looked at a specimen. This is the
// specimen.
//
// It is also the answer to the question that starts most font bugs: *which
// font am I actually getting?* On this machine `sans-serif` is Hiragino Sans
// W4 — a Japanese face, with a 0.5em line gap — because that is what
// `fc-match` ranks first, and nothing in an app's code says so (#86). The
// left column is that ranking, and the top row is what you get.
//
// ## What to try
//
//   sans-serif        the default nobody chose. Look at the line gap.
//   :lang=ru          fontconfig patterns pass straight through, so the
//   :lang=ja          query box is the real thing, not a family list.
//   monospace:bold
//
//   Coverage          type ₸ or 字 into the specimen and watch the coverage
//                     line: a character the face does not have is drawn from
//                     somebody else's, and this says whose.
//   Axes              a variable font grows a control per axis it declares —
//                     read off the file, not configured here.
//   Gradient/Shadow   the two decorations are drawn rather than styled, and
//                     the shadow is a server-side blur (see below).
//
// ## The two decorations, and why they are canvas
//
// react-x11's styles have no `linear-gradient` and no `box-shadow`, so both
// of these live in one `<canvas>` — which is the honest shape for them
// anyway: a specimen is a drawing.
//
// The gradient is `ctx.createLinearGradient`, ordinary canvas.
//
// The shadow is the interesting one. There is no `ctx.shadowBlur` here, so
// it is built from the pieces underneath: the text is drawn once into an
// **a8 surface** (a `Surface` stores coverage rather than colour), that
// surface's `Picture` gets a **RENDER convolution filter** — a gaussian, on
// the server — and the blurred coverage is then composited as a *mask* for
// whatever `fillStyle` is set. So the shadow is tinted at composite time,
// nothing but the composite crosses the wire, and the blur happens where the
// pixels already are. `paintShadowedText` below is the whole of it.
//
// ## What does not work
//
// **The list shows PostScript names, not families.** `matchSorted` answers
// `{path, postscriptName, charset}` — fc-match is asked for exactly those —
// so a family name means opening the file, at about 1.2ms each. For 139
// candidates that is 170ms of blocking on every keystroke, which is a worse
// trade than reading `HiraginoSans-W4` instead of `Hiragino Sans W4`. Only
// the selected face is opened.
//
// **Matching blocks.** `matchSorted` shells out to `fc-match` synchronously
// — 109ms cold on this machine, free once memoized. `useDeferredValue` keeps
// the query field responsive while the list catches up, the same shape
// `examples/monitor.jsx` uses for its filter.
import React, {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
} from 'react';

import {
  Select,
  Slider,
  Switch,
  createRoot,
  createStyles,
  useApp,
} from '../src/index.js';
// Through `react-x11/ntk`, never a second `ntk` dependency: two copies mean
// two font caches and two glyph atlases (see `src/ntk.js`).
import { Font, Surface } from '../src/ntk.js';

const SAMPLE = 'Sphinx of black quartz, judge my vow';

// ---------------------------------------------------------------------------
// The decorations
// ---------------------------------------------------------------------------

const GRADIENTS = [
  { id: 'slate', label: 'Slate', stops: ['#1f2937', '#0f172a'] },
  { id: 'dusk', label: 'Dusk', stops: ['#2b5876', '#4e4376'] },
  { id: 'ember', label: 'Ember', stops: ['#42275a', '#734b6d'] },
  { id: 'moss', label: 'Moss', stops: ['#134e5e', '#71b280'] },
  { id: 'paper', label: 'Paper', stops: ['#f8f7f4', '#e6e2da'] },
  { id: 'none', label: 'None', stops: null },
];

/** Light gradients want dark ink. Nothing else in the app cares. */
const inkFor = (gradient) => (gradient.id === 'paper' ? '#1c1b19' : '#f4f7ff');

/**
 * Text with a blurred copy of itself behind it.
 *
 * The blur is the server's: an `a8` surface holds the glyph coverage, a
 * RENDER convolution filter blurs that coverage in place, and compositing it
 * tints it with the current `fillStyle`. The alternative — blurring pixels
 * on the client and uploading them — is the thing this stack exists to avoid.
 */
function paintShadowedText(
  ctx,
  app,
  text,
  x,
  baseline,
  { blur, offset, colour },
) {
  const m = ctx.measureText(text);
  if (!(m.width > 0)) return;
  const ascent = Math.ceil(m.fontBoundingBoxAscent);
  const descent = Math.ceil(m.fontBoundingBoxDescent);
  // Room for the blur to spread into, or the kernel clips at the surface's
  // edge and the shadow ends in a straight line.
  const pad = blur * 2 + 4;
  const surface = new Surface(app, {
    width: Math.ceil(m.width) + pad * 2,
    height: ascent + descent + pad * 2,
    format: 'a8',
  });
  try {
    surface.render((c) => {
      c.font = ctx.font;
      c.fillStyle = '#fff'; // full coverage; the colour arrives at composite
      c.fillText(text, pad, pad + ascent);
    });
    if (blur > 0) surface.picture().setBlurFilter(blur);
    ctx.fillStyle = colour;
    // The surface's baseline is `pad + ascent` from its top, so this lands
    // the two baselines together and `offset` is the only thing that moves it.
    ctx.drawImage(surface, x - pad + offset, baseline - ascent - pad + offset);
  } finally {
    surface.destroy();
  }
}

/** The specimen: a gradient, a shadow, and the face itself. */
function paintSpecimen(ctx, { width, height, node }, opts) {
  const { gradient, text, size, family, variations, shadow } = opts;
  const app = node.app;

  if (gradient.stops) {
    // **Window coordinates, not the node's.** `<canvas>` translates the
    // context to the node's origin before `onDraw`, and a CanvasGradient's
    // points do not go through that transform — so a gradient built at
    // (0,0)-(width,0) starts painting at the *window's* left edge and has run
    // out by the time it reaches the far side of a canvas that is not at
    // x=0. Horizontal, too: past its last stop a RENDER gradient is
    // transparent, and a diagonal one runs out before the far corners.
    const { x: ox, y: oy } = node.abs;
    const fill = ctx.createLinearGradient(ox, oy, ox + width, oy);
    fill.addColorStop(0, gradient.stops[0]);
    fill.addColorStop(1, gradient.stops[1]);
    ctx.fillStyle = fill;
  } else {
    ctx.fillStyle = '#0e1116';
  }
  ctx.fillRect(0, 0, width, height);

  if (!family || !text) return;

  ctx.font = `${size}px "${family}"`;
  if (variations) ctx.fontVariationSettings = variations;

  const baseline = Math.round(height / 2 + size * 0.34);
  if (shadow > 0) {
    paintShadowedText(ctx, app, text, 18, baseline, {
      blur: shadow,
      offset: Math.round(shadow / 2),
      colour: '#05070a',
    });
  }
  ctx.fillStyle = inkFor(gradient);
  ctx.fillText(text, 18, baseline);
}

// ---------------------------------------------------------------------------
// Seam: the catalogue
//
// fontconfig answers differently on every machine — that is the whole point
// of the app and the reason its tests cannot use it. `fixedCatalogue` is a
// list of files, which is what the tests hand it.
// ---------------------------------------------------------------------------

export function fontconfigCatalogue(app) {
  return {
    kind: 'fontconfig',
    /** A raw fontconfig pattern: `sans-serif`, `:lang=ru`, `Menlo:bold`. */
    match(query) {
      // `patternFor` concatenates, so a whole pattern passed as the family
      // reaches fc-match intact — which is why the query box can be the real
      // thing rather than a family picker.
      return app.fonts.source.matchSorted({ family: query || 'sans-serif' });
    },
    open: (path) => Font.loadSync(path),
  };
}

export function fixedCatalogue(paths) {
  return {
    kind: 'fixed',
    match(query) {
      const q = String(query ?? '').toLowerCase();
      const all = paths.map((path) => ({
        path,
        postscriptName: path
          .split('/')
          .pop()
          .replace(/\.[^.]+$/, ''),
        charset: '',
      }));
      if (!q || q === 'sans-serif') return all;
      return all.filter((m) => m.postscriptName.toLowerCase().includes(q));
    },
    open: (path) => Font.loadSync(path),
  };
}

// ---------------------------------------------------------------------------
// Reading a face
// ---------------------------------------------------------------------------

const AXIS_NAMES = {
  wght: 'Weight',
  wdth: 'Width',
  slnt: 'Slant',
  ital: 'Italic',
  opsz: 'Optical size',
};

/** Everything the detail pane shows, or `{ error }` if the file will not open. */
function describe(catalogue, path, size) {
  try {
    const font = catalogue.open(path);
    return {
      font,
      familyName: font.familyName,
      postscriptName: font.postscriptName,
      unitsPerEm: font.unitsPerEm,
      metrics: font.metrics(size),
      axes: font.variationAxes ?? {},
    };
  } catch (err) {
    return { error: String(err?.message ?? err) };
  }
}

/** Which characters of `text` this face has, and which it does not. */
function coverageOf(font, text) {
  if (!font) return { missing: [], total: 0 };
  const seen = new Set();
  const missing = [];
  for (const ch of text) {
    if (seen.has(ch) || ch === ' ') continue;
    seen.add(ch);
    try {
      if (!font.hasGlyph(ch.codePointAt(0))) missing.push(ch);
    } catch {
      // a face that cannot answer is not a face that is missing the glyph
    }
  }
  return { missing, total: seen.size };
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const s = createStyles({
  root: { flexGrow: 1, flexDirection: 'row', backgroundColor: '$background' },
  side: {
    width: 264,
    flexDirection: 'column',
    gap: 8,
    padding: 12,
    borderEndWidth: 1,
    borderColor: '$border',
  },
  field: {
    height: 30,
    borderWidth: 1,
    borderColor: '$border',
    borderRadius: 6,
    paddingStart: 8,
    paddingEnd: 8,
    backgroundColor: '$surface',
    ':focus': { borderColor: '$accent' },
  },
  quick: { flexDirection: 'row', gap: 4, flexWrap: 'wrap' },
  chip: {
    paddingStart: 7,
    paddingEnd: 7,
    paddingTop: 3,
    paddingBottom: 3,
    borderRadius: 5,
    backgroundColor: '$surface',
    ':hover': { backgroundColor: '$surfaceHover' },
  },
  chipText: { fontSize: 11, color: '$textMuted' },
  list: { flexGrow: 1, overflow: 'scroll', gap: 1 },
  row: {
    flexDirection: 'column',
    gap: 1,
    paddingStart: 8,
    paddingEnd: 8,
    paddingTop: 5,
    paddingBottom: 5,
    borderRadius: 6,
    ':hover': { backgroundColor: '$surfaceHover' },
  },
  rowOn: {
    backgroundColor: '$accent',
    ':hover': { backgroundColor: '$accentHover' },
  },
  rowName: { fontSize: 12, color: '$text' },
  rowNameOn: { color: '$accentText' },
  rowFile: { fontSize: 10, color: '$textMuted' },
  rowFileOn: { color: '$accentText' },
  winner: { fontSize: 10, color: '$success' },

  main: { flexGrow: 1, flexDirection: 'column' },
  specimen: { height: 150 },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 10,
    paddingStart: 14,
    paddingEnd: 14,
    paddingTop: 8,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderColor: '$border',
  },
  detail: {
    flexGrow: 1,
    overflow: 'scroll',
    flexDirection: 'column',
    gap: 14,
    padding: 14,
  },
  h: { fontSize: 12, color: '$textMuted' },
  family: { fontSize: 20, color: '$text' },
  facts: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  fact: { width: 132, flexDirection: 'column', gap: 1 },
  factLabel: { fontSize: 10, color: '$textMuted' },
  factValue: { fontSize: 13, color: '$text' },
  path: { fontSize: 10, color: '$textMuted' },
  miss: { fontSize: 12, color: '$warning' },
  ok: { fontSize: 12, color: '$success' },
  axis: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  axisName: { width: 120, fontSize: 12, color: '$text' },
  axisValue: { width: 56, fontSize: 12, color: '$textMuted', textAlign: 'end' },
  error: { fontSize: 12, color: '$danger' },
  label: { fontSize: 11, color: '$textMuted' },
});

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

const QUICK = ['sans-serif', 'serif', 'monospace', ':lang=ru', ':lang=ja'];

function MatchList({ matches, selected, onSelect }) {
  return (
    <box style={s.list} data-testname="matches">
      {matches.map((m, i) => {
        const on = m.path === selected;
        return (
          <box
            key={`${m.path}#${m.postscriptName}#${i}`}
            style={[s.row, on && s.rowOn]}
            role="option"
            aria-label={m.postscriptName}
            focusable
            onClick={() => onSelect(m.path)}
          >
            <text style={[s.rowName, on && s.rowNameOn]}>
              {m.postscriptName || '(unnamed)'}
            </text>
            {i === 0 ? (
              <text style={on ? s.rowFileOn : s.winner}>
                what this query gives you
              </text>
            ) : (
              <text style={[s.rowFile, on && s.rowFileOn]}>
                {m.path.split('/').pop()}
              </text>
            )}
          </box>
        );
      })}
    </box>
  );
}

function Facts({ info, size }) {
  const m = info.metrics;
  // `capHeight` and `xHeight` are `null` when the face does not declare them
  // — Comic Sans MS is one — and saying so is more use than a number. The
  // renderer takes the same view: `_lineMetrics` leaves the box alone rather
  // than centring on a value it does not have.
  const px = (v) =>
    v == null || Number.isNaN(v) ? 'not declared' : `${v.toFixed(2)}px`;
  const rows = [
    ['PostScript', info.postscriptName],
    ['Units per em', String(info.unitsPerEm)],
    ['Ascent', px(m.ascent)],
    ['Descent', px(m.descent)],
    ['Line gap', px(m.lineGap)],
    ['Line height', px(m.lineHeight)],
    ['Cap height', px(m.capHeight)],
    ['x-height', px(m.xHeight)],
  ];
  return (
    <box style={{ flexDirection: 'column', gap: 6 }} data-testname="facts">
      <text style={s.h}>{`Metrics at ${size}px`}</text>
      <box style={s.facts}>
        {rows.map(([label, value]) => (
          <box key={label} style={s.fact}>
            <text style={s.factLabel}>{label}</text>
            <text style={s.factValue}>{value}</text>
          </box>
        ))}
      </box>
      {m.lineGap > size * 0.3 ? (
        <text style={s.miss}>
          {`A ${(m.lineGap / size).toFixed(2)}em line gap — this face will set much looser than a Latin one.`}
        </text>
      ) : null}
    </box>
  );
}

function Coverage({ font, text }) {
  const { missing, total } = useMemo(
    () => coverageOf(font, text),
    [font, text],
  );
  return (
    <box style={{ flexDirection: 'column', gap: 4 }} data-testname="coverage">
      <text style={s.h}>Coverage</text>
      {missing.length === 0 ? (
        <text style={s.ok}>
          {`This face has all ${total} characters in the specimen.`}
        </text>
      ) : (
        <text style={s.miss}>
          {`Not in this face: ${missing.join(' ')} — drawn from a fallback, so what you see is another font's work.`}
        </text>
      )}
    </box>
  );
}

function Axes({ axes, values, onChange }) {
  const ids = Object.keys(axes);
  if (!ids.length) {
    return (
      <box style={{ flexDirection: 'column', gap: 4 }} data-testname="axes">
        <text style={s.h}>Variable axes</text>
        <text style={s.label}>
          This face declares none — `font.variationAxes` is empty.
        </text>
      </box>
    );
  }
  return (
    <box style={{ flexDirection: 'column', gap: 8 }} data-testname="axes">
      <text style={s.h}>Variable axes</text>
      {ids.map((id) => {
        const axis = axes[id];
        const value = values[id] ?? axis.default;
        return (
          <box key={id} style={s.axis} role="group" aria-label={id}>
            <text
              style={s.axisName}
            >{`${AXIS_NAMES[id] ?? axis.name ?? id} (${id})`}</text>
            {axis.min === axis.max ? (
              <text style={s.label}>{`pinned at ${axis.min}`}</text>
            ) : (
              <>
                <Slider
                  style={{ flexGrow: 1 }}
                  min={axis.min}
                  max={axis.max}
                  value={value}
                  aria-label={`${id} axis`}
                  onChange={(ev) => onChange(id, ev.value)}
                />
                <text style={s.axisValue}>{Math.round(value)}</text>
              </>
            )}
          </box>
        );
      })}
    </box>
  );
}

export function FontsPanel({
  catalogue: given = null,
  initialQuery = 'sans-serif',
  initialText = SAMPLE,
}) {
  const app = useApp();
  const catalogue = useMemo(
    () => given ?? (app ? fontconfigCatalogue(app) : null),
    [given, app],
  );

  const [query, setQuery] = useState(initialQuery);
  const [selected, setSelected] = useState(null);
  const [text, setText] = useState(initialText);
  const [size, setSize] = useState(30);
  const [gradientId, setGradientId] = useState('dusk');
  const [shadow, setShadow] = useState(7);
  const [axisValues, setAxisValues] = useState({});

  // `matchSorted` is a synchronous subprocess — 109ms the first time a
  // pattern is seen. Deferring it keeps the field's caret moving while the
  // list is a keystroke behind, which is the honest trade: the field is the
  // thing being typed into, the list is the thing being read.
  const settled = useDeferredValue(query);

  // A failure is part of the result, not a state update: `matchSorted` throws
  // where fontconfig is missing or has no usable font, and setting state from
  // inside a memo would be a write during render.
  const { matches, failed } = useMemo(() => {
    if (!catalogue) return { matches: [], failed: null };
    try {
      return { matches: catalogue.match(settled).slice(0, 200), failed: null };
    } catch (err) {
      return { matches: [], failed: String(err?.message ?? err) };
    }
  }, [catalogue, settled]);

  // The selection follows the query unless the reader has picked something
  // that is still in the new list.
  const current = matches.some((m) => m.path === selected)
    ? selected
    : (matches[0]?.path ?? null);

  const info = useMemo(
    () => (catalogue && current ? describe(catalogue, current, size) : null),
    [catalogue, current, size],
  );

  useEffect(() => setAxisValues({}), [current]);

  // The specimen draws through `ctx.font`, which resolves through
  // `app.fonts` — so the chosen file is registered under a private family
  // name. Registering under its own family would fight fontconfig for it.
  const SPECIMEN_FAMILY = 'x11-fonts-specimen';
  const [registered, setRegistered] = useState(null);
  useEffect(() => {
    if (!app || !current) return;
    try {
      app.fonts.load(current, { family: SPECIMEN_FAMILY });
      setRegistered(current);
    } catch {
      setRegistered(null);
    }
  }, [app, current]);

  const gradient = GRADIENTS.find((g) => g.id === gradientId) ?? GRADIENTS[0];
  const variations = useMemo(
    () => (Object.keys(axisValues).length ? axisValues : null),
    [axisValues],
  );

  const draw = useCallback(
    (ctx, box) =>
      paintSpecimen(ctx, box, {
        gradient,
        text,
        size,
        family: registered ? SPECIMEN_FAMILY : null,
        variations,
        shadow,
      }),
    [gradient, text, size, registered, variations, shadow],
  );

  const setAxis = useCallback(
    (id, value) => setAxisValues((prev) => ({ ...prev, [id]: value })),
    [],
  );

  return (
    <box style={s.root}>
      <box style={s.side}>
        <textinput
          style={s.field}
          value={query}
          placeholder="sans-serif"
          aria-label="Font query"
          onChange={(ev) => setQuery(ev.value)}
        />
        <box style={s.quick}>
          {QUICK.map((q) => (
            <box
              key={q}
              style={s.chip}
              role="button"
              aria-label={q}
              focusable
              onClick={() => setQuery(q)}
            >
              <text style={s.chipText}>{q}</text>
            </box>
          ))}
        </box>
        <text style={s.label}>
          {failed ? '' : `${matches.length} candidates, best first`}
        </text>
        {failed ? <text style={s.error}>{failed}</text> : null}
        <MatchList
          matches={matches}
          selected={current}
          onSelect={setSelected}
        />
      </box>

      <box style={s.main}>
        <box style={s.specimen}>
          <canvas style={{ flexGrow: 1 }} onDraw={draw} />
        </box>

        <box style={s.controls}>
          <textinput
            style={[s.field, { flexGrow: 1 }]}
            value={text}
            placeholder="type a specimen"
            aria-label="Specimen text"
            onChange={(ev) => setText(ev.value)}
          />
          <text style={s.label}>Size</text>
          <Slider
            style={{ width: 110 }}
            min={10}
            max={96}
            value={size}
            aria-label="Size"
            onChange={(ev) => setSize(Math.round(ev.value))}
          />
          <text style={s.label}>{`${size}px`}</text>
          <Select
            style={{ width: 120 }}
            value={gradientId}
            aria-label="Background"
            options={GRADIENTS.map((g) => ({ value: g.id, label: g.label }))}
            onChange={(ev) => setGradientId(ev.value)}
          />
          <text style={s.label}>Shadow</text>
          <Switch
            checked={shadow > 0}
            aria-label="Shadow"
            onChange={(ev) => setShadow(ev.checked ? 7 : 0)}
          />
          <Slider
            style={{ width: 90 }}
            min={0}
            max={20}
            value={shadow}
            aria-label="Shadow blur"
            onChange={(ev) => setShadow(Math.round(ev.value))}
          />
        </box>

        <box style={s.detail} data-testname="detail">
          {!info ? (
            <text style={s.label}>Nothing matched that query.</text>
          ) : info.error ? (
            <text style={s.error}>{info.error}</text>
          ) : (
            <>
              <box style={{ flexDirection: 'column', gap: 2 }}>
                <text style={s.family}>{info.familyName}</text>
                <text style={s.path}>{current}</text>
              </box>
              <Facts info={info} size={size} />
              <Coverage font={info.font} text={text} />
              <Axes axes={info.axes} values={axisValues} onChange={setAxis} />
            </>
          )}
        </box>
      </box>
    </box>
  );
}

function App(props) {
  return (
    <window
      width={980}
      height={640}
      title="Fonts"
      wmClass="com.example.x11fonts"
      style={{ flexGrow: 1 }}
    >
      <FontsPanel {...props} />
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<App initialQuery={process.argv[2] || 'sans-serif'} />);
}

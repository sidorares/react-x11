// `transition` and `animation` — the two shapes a style can move in — side
// by side, and where each one runs.
//
//   npm run examples:animation
//
// The three cards answer the pointer, the loops under them never stop, and
// the terminal beside the window prints how many frames a second the JS
// side is painting. That number is the difference between the backends:
//
//   On X11 every animation is a frame this process paints, at the
//   display's rate, for as long as anything moves. The counter reads ~60,
//   and "Block JS for 2 s" freezes all of it.
//
//   On macOS a plain <box>'s colour, border width and radius are handed to
//   Core Animation (react-x11 #472): the style goes straight to its
//   target, the render server draws the way there, and no frame is
//   scheduled for it. The surface presenter — the default — does it by
//   promotion (#483): the three tiles, the chip and the hovered card get a
//   layer of their own above the window's bitmap for as long as they
//   animate, and the bitmap keeps the frame for everything else. The layer
//   presenter has a layer for every box to begin with. Either way, untick
//   "position · text ink · ProgressBar" and the counter reads 0 while the
//   three tiles keep pulsing; press the button and they pulse straight
//   through the block.
//
//   REACT_X11_DEBUG_PROMOTION=1 npm run examples:animation        # macOS:
//                                    # which node got a layer, which did not
//                                    # and what was in its way; whether
//                                    # promotion is on at all (it needs
//                                    # @windowkit/appkit >= 0.5.1)
//   REACT_X11_COCOA_PROMOTE=0 npm run examples:animation           # macOS,
//                                              # every animation on the clock
//   REACT_X11_COCOA_PRESENTER=layers npm run examples:animation   # macOS
//   REACT_X11_BACKEND=x11 npm run examples:animation              # XQuartz
//
// Reduce motion — System Settings › Accessibility › Display on macOS,
// Gtk/EnableAnimations over XSETTINGS elsewhere — stops the loops, live,
// and leaves the transitions alone: the switch is for motion that means
// nothing, and a card answering a click is not that.
//
// docs/styling.md ("Transitions", "Loops") is the reference, and
// docs/architecture/animation.md is what comes next: easing on a
// transition, timelines that end, opacity, transforms.
import React, { useEffect, useRef, useState } from 'react';
import {
  Button,
  Checkbox,
  ProgressBar,
  createRoot,
  createStyles,
  useDesktopSettings,
} from '../src/index.js';
import { watchFrames } from './stress/perf.js';

const TRACK = 168; // the easing tracks, and the width of everything beside them
const DOT = 14;
const EASINGS = ['linear', 'ease-in', 'ease-out', 'ease-in-out'];

const s = createStyles({
  root: {
    flexGrow: 1,
    padding: 16,
    gap: 14,
    backgroundColor: '$background',
  },
  heading: { fontSize: 17, color: '$text' },
  section: { gap: 8 },
  title: { color: '$text', fontSize: 13 },
  // `minWidth: 0` is what lets a paragraph wrap where it sits: a flex item
  // keeps its content's floor unless it says so, and a caption beside a
  // chip in a row would otherwise hold the row open at its full length.
  hint: { color: '$textMuted', fontSize: 12, minWidth: 0 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  columns: { flexDirection: 'row', gap: 12 },
  // …and the same for a column that is meant to be narrower than its
  // longest line.
  column: { flexGrow: 1, flexBasis: 0, minWidth: 0, gap: 8 },

  // --- transitions -----------------------------------------------------------

  card: {
    flexGrow: 1,
    flexBasis: 0,
    minWidth: 0,
    padding: 12,
    gap: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '$border',
    backgroundColor: '$surface',
  },
  // Answers the pointer. The two state blocks and the two durations are the
  // whole declaration: the renderer knows which node the pointer is over,
  // so this is a repaint of one node and not a render of anything.
  hoverCard: {
    transition: { backgroundColor: 160, borderColor: 160 },
    ':hover': { backgroundColor: '$surfaceHover', borderColor: '$accent' },
    ':active': { backgroundColor: '$surfaceActive' },
  },
  // A click grows and rounds the chip; `transition: 600` is the shorthand
  // that covers every property that changes. Three of them here, and each
  // one interpolates on its own — click again mid-flight and each reverses
  // from wherever it got to.
  chip: {
    width: 44,
    height: 44,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '$border',
    backgroundColor: '$track',
    transition: 600,
  },
  chipGrown: {
    borderRadius: 22,
    borderWidth: 6,
    borderColor: '$accent',
    backgroundColor: '$surface',
  },
  // The bar's width is layout: yoga runs for every frame of it, and the chip
  // after it is pushed along. That is the transition no presenter can take
  // off the frame clock, on any backend.
  lane: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  bar: {
    width: '25%',
    height: 14,
    borderRadius: 7,
    backgroundColor: '$accent',
    transition: { width: 600 },
  },
  barWide: { width: '75%' },
  pushed: {
    width: DOT,
    height: DOT,
    borderRadius: DOT / 2,
    backgroundColor: '$textMuted',
  },

  // --- loops -----------------------------------------------------------------

  tile: {
    width: 48,
    height: 48,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '$border',
    backgroundColor: '$surface',
  },
  // `from` is left off every loop below on purpose: it defaults to what the
  // same style declares, so the declared value is both where the tile rests
  // — before the first frame, off screen, under reduced motion — and where
  // each crossing starts. (`createStyles` checks that at the declaration,
  // which is why each loop repeats the tile's resting value beside it.)
  pulse: {
    backgroundColor: '$surface',
    animation: {
      backgroundColor: { to: '$accent', duration: 900, alternate: true },
    },
  },
  breathe: {
    borderWidth: 1,
    borderColor: '$accent',
    animation: {
      borderWidth: {
        to: 6,
        duration: 700,
        alternate: true,
        easing: 'ease-in-out',
      },
    },
  },
  round: {
    borderRadius: 8,
    backgroundColor: '$track',
    animation: {
      borderRadius: {
        to: 24,
        duration: 1200,
        alternate: true,
        easing: 'ease-in-out',
      },
    },
  },
  // A border width is layout as well as paint — the content box shrinks —
  // so on the frame clock each of its frames is a layout pass, and the
  // damage claimed for a node that moves in layout is its parent. This slot
  // is that parent, and the breathing tile sits absolutely inside it so the
  // claim is 48x48 and not the window.
  slot: { width: 48, height: 48 },
  inSlot: { position: 'absolute', top: 0, start: 0 },

  easingName: { width: 78, color: '$textMuted', fontSize: 12 },
  track: {
    width: TRACK,
    height: DOT,
    borderRadius: DOT / 2,
    backgroundColor: '$track',
    justifyContent: 'center',
  },
  dot: {
    position: 'absolute',
    start: 0,
    width: DOT,
    height: DOT,
    borderRadius: DOT / 2,
    backgroundColor: '$accent',
  },
  // Text has no layer of its own to animate on — its ink is in its bitmap —
  // so a colour loop on it is a re-raster per frame, and stays on the frame
  // clock even where the tiles above do not.
  ink: {
    color: '$textMuted',
    animation: { color: { to: '$accent', duration: 900, alternate: true } },
  },
});

// One track per easing, all the same crossing, so the four dots leave and
// arrive together and differ only in between — which is what an easing is.
const slide = createStyles(
  Object.fromEntries(
    EASINGS.map((easing) => [
      easing,
      {
        start: 0,
        animation: {
          start: { to: TRACK - DOT, duration: 1200, alternate: true, easing },
        },
      },
    ]),
  ),
);

function Section({ title, children }) {
  return (
    <box style={s.section}>
      <text style={s.title}>{title}</text>
      {children}
    </box>
  );
}

function Transitions() {
  const [grown, setGrown] = useState(false);
  const [wide, setWide] = useState(false);
  return (
    <Section title="transition — a change, over so many ms">
      <box style={s.columns}>
        <box style={[s.card, s.hoverCard]}>
          <text style={s.hint}>hover, press</text>
          <text style={s.hint}>backgroundColor, borderColor · 160 ms</text>
        </box>

        <box style={s.card} onClick={() => setGrown((g) => !g)}>
          <box style={s.row}>
            <box data-testname="chip" style={[s.chip, grown && s.chipGrown]} />
            <text style={s.hint}>click, and again before it lands</text>
          </box>
          <text style={s.hint}>
            borderWidth, borderRadius, colours · 600 ms
          </text>
        </box>

        <box style={s.card} onClick={() => setWide((w) => !w)}>
          <box style={s.lane}>
            <box data-testname="bar" style={[s.bar, wide && s.barWide]} />
            <box style={s.pushed} />
          </box>
          <text style={s.hint}>width — layout, so yoga runs per frame</text>
        </box>
      </box>
    </Section>
  );
}

function Loops() {
  const [layer, setLayer] = useState(true);
  const [clock, setClock] = useState(true);
  return (
    <Section title="animation — a loop between two values">
      <box style={s.columns}>
        <box style={s.column}>
          <Checkbox checked={layer} onChange={(ev) => setLayer(ev.value)}>
            colour · border · radius
          </Checkbox>
          <box style={s.row}>
            <box data-testname="pulse" style={[s.tile, layer && s.pulse]} />
            <box style={s.slot}>
              <box
                data-testname="breathe"
                style={[s.tile, s.inSlot, layer && s.breathe]}
              />
            </box>
            <box data-testname="round" style={[s.tile, layer && s.round]} />
          </box>
          <text style={s.hint}>
            Plain boxes. On macOS these run in the render server and cost no
            frames; everywhere else, the frame clock.
          </text>
        </box>

        <box style={s.column}>
          <Checkbox checked={clock} onChange={(ev) => setClock(ev.value)}>
            position · text ink · ProgressBar
          </Checkbox>
          {EASINGS.map((easing) => (
            <box key={easing} style={s.row}>
              <text style={s.easingName}>{easing}</text>
              <box style={s.track}>
                <box style={[s.dot, clock && slide[easing]]} />
              </box>
            </box>
          ))}
          <box style={s.row}>
            <text style={s.easingName}>ProgressBar</text>
            <ProgressBar
              indeterminate={clock}
              value={0.3}
              style={{ width: TRACK }}
            />
          </box>
          <box style={s.row}>
            <text style={s.easingName}>text ink</text>
            <text style={[s.hint, clock && s.ink]}>
              a colour loop on {'<text>'}
            </text>
          </box>
          <text style={s.hint}>
            Layout, and ink in a bitmap: the frame clock on every backend.
          </text>
        </box>
      </box>
    </Section>
  );
}

function ReduceMotion() {
  const { animations, source } = useDesktopSettings();
  return (
    <Section title="reduce motion">
      <text style={s.hint}>
        {`useDesktopSettings().animations → ${animations}   source: ${
          source ?? 'none, the defaults'
        }`}
      </text>
      <text style={s.hint}>
        The loops stop when the desktop asks and the transitions keep answering.
        Flip it while this runs — macOS: System Settings › Accessibility ›
        Display; GNOME: Settings › Accessibility.
      </text>
    </Section>
  );
}

/** Hold the JS thread. A frame that has to come from here does not come. */
function block(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until);
}

/** The demo without a window round it, for the test and for examples/app.jsx. */
export function AnimationPanel() {
  return (
    <>
      <text style={s.heading}>transition and animation</text>
      <Transitions />
      <Loops />
      <ReduceMotion />
      <box style={s.row}>
        <Button onPress={() => block(2000)}>Block JS for 2 s</Button>
        <text style={s.hint}>
          What keeps moving was not this process's to draw.
        </text>
      </box>
    </>
  );
}

function App({ onRoot }) {
  const shell = useRef(null);
  // A ref on a drawn node is the node itself; `node.root` is the WindowNode
  // that owns the frame loop, which is what the counter below watches.
  useEffect(() => {
    const root = shell.current?.root;
    if (root) onRoot?.(root);
  }, [onRoot]);
  return (
    <window width={640} height={570} title="animation">
      <box ref={shell} style={s.root}>
        <AnimationPanel />
      </box>
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  let watcher = null;
  let timer = null;

  root.render(
    <App
      onRoot={(node) => {
        if (watcher) return;
        // The window's animation seam exists only where a presenter can take
        // an animation (src/cocoa/window.js: the layer presenter, and the
        // surface presenter's promotion); its absence is every other
        // backend, where the frame clock runs all of it.
        const wnd = node.window;
        const offloads = typeof wnd?.animateNode === 'function';
        process.stdout.write(
          !offloads
            ? '\n  frame clock: every animation is a frame this process paints\n'
            : wnd._promotion
              ? '\n  surface presenter: the plain-box loops run in the render server, on layers of their own\n'
              : '\n  layer presenter: the plain-box loops run in the render server\n',
        );
        // The stress app's frame instrument, silenced — a line per frame is
        // the wrong unit here. Frames per second is the number, and it is
        // printed when it changes rather than every second, so a steady
        // state is one line.
        watcher = watchFrames(node, { quiet: Infinity });
        let seen = 0;
        let shown = null;
        timer = setInterval(() => {
          const n = watcher.frames - seen;
          seen = watcher.frames;
          const same =
            shown !== null &&
            (n === 0) === (shown === 0) &&
            Math.abs(n - shown) <= 3;
          if (same) return;
          shown = n;
          const at = new Date().toLocaleTimeString();
          process.stdout.write(`  ${at}  ${String(n).padStart(3)} frames/s\n`);
        }, 1000);
        timer.unref();
      }}
    />,
  );

  const bye = () => {
    clearInterval(timer);
    if (watcher) {
      process.stdout.write(`\n  ${watcher.report()}\n\n`);
      watcher.stop();
    }
    process.exit(0);
  };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

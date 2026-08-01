// A wall of 400 icon-sized `<svg>` elements that reflows on every resize.
//
//   npm run examples:icons                    400 icons from `source` strings
//   npm run examples:icons -- --mode=jsx      the same icons as JSX children
//   npm run examples:icons -- --count=800 --size=16
//   npm run examples:icons -- --count=1200    tall enough to scroll on sight
//   npm run examples:icons -- --quiet         log only frames over 50kpx
//
// Everything is drivable from the window: the **glyph control** switch swaps
// every cell between its `<svg>` and one cached glyph, and the two sliders
// set count and size. Press 1 / 2 for the two SVG modes. Drag the window
// edge to reflow. The grid and the cell count stay identical throughout, so
// frame logs from either side of the switch are directly comparable.
//
// The wall lives in a `<scrollview>`, which puts the *other* expensive frame
// on the wheel: a scroll moves every cell without changing one of them. Those
// frames log as `scroll`, and the damage column is where to look — the scroll
// blit (issue #138) copies the surviving band in the backing pixmap and
// repaints only the strip the scroll exposed, so a wheel notch reads as
// `2 rect 26kpx` where the same viewport repainted whole is `211kpx`. A big
// enough jump keeps less than half the viewport, misses the blit's gate and
// falls back to the full repaint — the two lines sitting next to each other
// in the log is the point. `REACT_X11_NO_SCROLL_BLIT=1` turns the fast path
// off to measure against it.
//
// At the default 400 x 20px the wall is 544px tall and the viewport is 790,
// so there is nothing to scroll until you raise `count` past ~600 or drag the
// window smaller. That is deliberate: the numbers this example was baselined
// with are the ones an untouched window still produces.
//
// Why this shape: `<svg>` has no cached rasterization, so `SvgView.draw`
// re-walks the parsed document on every repaint — Path2D, flatten, stroke
// extrusion, then a FillRectangles + AddTraps + Composite per subpath. A
// resize is the worst honest case for that: the wrap changes, every cell
// moves, and all 400 icons redraw with unchanged *content*. That is exactly
// the frame a rasterization cache would turn into 400 Composites.
//
// The glyph control is the baseline. It draws one cached glyph per cell
// instead of one SVG, through the machinery that already does what we would
// want the icons to do — a byte per cell inside one CompositeGlyphs. The gap
// across that switch, in the ms column, is the size of the prize.
//
// The frame log goes to stdout, not into the window: a HUD would claim damage
// every frame and change the number it was reporting. See stress/perf.js.
import React, { useEffect, useRef, useState } from 'react';
import { createRoot, createStyles, Slider, Switch } from '../src/index.js';

// --- the icons -------------------------------------------------------------
//
// Eight lucide-shaped drawings on a 24x24 grid: monochrome, stroked, 6-10
// primitives each. They are described once as data rather than as markup so
// that the `source` and `jsx` modes render provably the same geometry — the
// two modes reach SvgView by different routes (a parsed string vs. a DOM
// assembled from host nodes) and comparing them is only meaningful if the
// drawing is identical.
//
// Mixed element types on purpose: <path> with arcs, <circle>, <line>,
// <polyline> and <rect> take different routes through ntk's path code, and an
// icon set that was all <path> would measure only one of them.
const ICONS = {
  gauge: [
    { t: 'path', d: 'M4.2 16.5a8.5 8.5 0 1 1 15.6 0' },
    { t: 'line', x1: 12, y1: 15.5, x2: 16.6, y2: 10.4 },
    { t: 'circle', cx: 12, cy: 15.7, r: 1.5 },
    { t: 'line', x1: 4.6, y1: 12.6, x2: 6.3, y2: 13 },
    { t: 'line', x1: 7.2, y1: 9.2, x2: 8.4, y2: 10.4 },
    { t: 'line', x1: 12, y1: 7.6, x2: 12, y2: 9.3 },
    { t: 'line', x1: 16.8, y1: 9.2, x2: 15.6, y2: 10.4 },
    { t: 'line', x1: 19.4, y1: 12.6, x2: 17.7, y2: 13 },
    { t: 'line', x1: 3.5, y1: 19.5, x2: 20.5, y2: 19.5 },
  ],
  layers: [
    { t: 'path', d: 'M12 2.8 2.8 7.4 12 12l9.2-4.6z' },
    { t: 'path', d: 'M2.8 12 12 16.6 21.2 12' },
    { t: 'path', d: 'M2.8 16.6 12 21.2l9.2-4.6' },
    { t: 'line', x1: 6.4, y1: 9.2, x2: 6.4, y2: 10.6 },
    { t: 'line', x1: 17.6, y1: 9.2, x2: 17.6, y2: 10.6 },
    { t: 'circle', cx: 12, cy: 7.4, r: 1.1 },
  ],
  cloudBolt: [
    {
      t: 'path',
      d: 'M7.2 15.6a4.2 4.2 0 0 1-.3-8.4 5.7 5.7 0 0 1 11 1.4 3.5 3.5 0 0 1-1.1 7H7.2z',
    },
    { t: 'polyline', points: '13 12.6 10.2 17 12.9 17 10.6 21.4' },
    { t: 'line', x1: 6.4, y1: 18.2, x2: 5.4, y2: 20.4 },
    { t: 'line', x1: 9, y1: 18.6, x2: 8.2, y2: 20.4 },
    { t: 'line', x1: 15.4, y1: 18.2, x2: 14.6, y2: 20.4 },
    { t: 'line', x1: 17.9, y1: 18.6, x2: 17.1, y2: 20.4 },
    { t: 'circle', cx: 12, cy: 9.4, r: 0.9 },
  ],
  compass: [
    { t: 'circle', cx: 12, cy: 12, r: 9 },
    { t: 'path', d: 'M15.8 8.2 13.2 14 7.4 16.6 10 10.8z' },
    { t: 'circle', cx: 12, cy: 12, r: 0.9 },
    { t: 'line', x1: 12, y1: 1.6, x2: 12, y2: 3.4 },
    { t: 'line', x1: 12, y1: 20.6, x2: 12, y2: 22.4 },
    { t: 'line', x1: 1.6, y1: 12, x2: 3.4, y2: 12 },
    { t: 'line', x1: 20.6, y1: 12, x2: 22.4, y2: 12 },
  ],
  cpu: [
    { t: 'rect', x: 5, y: 5, width: 14, height: 14, rx: 2 },
    { t: 'rect', x: 9, y: 9, width: 6, height: 6 },
    { t: 'line', x1: 9.5, y1: 2, x2: 9.5, y2: 5 },
    { t: 'line', x1: 14.5, y1: 2, x2: 14.5, y2: 5 },
    { t: 'line', x1: 9.5, y1: 19, x2: 9.5, y2: 22 },
    { t: 'line', x1: 14.5, y1: 19, x2: 14.5, y2: 22 },
    { t: 'line', x1: 2, y1: 9.5, x2: 5, y2: 9.5 },
    { t: 'line', x1: 2, y1: 14.5, x2: 5, y2: 14.5 },
    { t: 'line', x1: 19, y1: 9.5, x2: 22, y2: 9.5 },
    { t: 'line', x1: 19, y1: 14.5, x2: 22, y2: 14.5 },
  ],
  flask: [
    {
      t: 'path',
      d: 'M9.2 2.8v6.4l-4.7 8.5A2 2 0 0 0 6.3 20.8h11.4a2 2 0 0 0 1.8-3.1l-4.7-8.5V2.8',
    },
    { t: 'line', x1: 8, y1: 2.8, x2: 16, y2: 2.8 },
    { t: 'line', x1: 6.9, y1: 14.4, x2: 17.1, y2: 14.4 },
    { t: 'circle', cx: 10.4, cy: 17.2, r: 1.1 },
    { t: 'circle', cx: 13.8, cy: 18.4, r: 0.8 },
    { t: 'circle', cx: 13.2, cy: 15.9, r: 0.6 },
  ],
  chart: [
    { t: 'polyline', points: '3.6 3.6 3.6 20.4 20.4 20.4' },
    { t: 'rect', x: 6.4, y: 13.6, width: 2.6, height: 6.8 },
    { t: 'rect', x: 11, y: 10, width: 2.6, height: 10.4 },
    { t: 'rect', x: 15.6, y: 15.2, width: 2.6, height: 5.2 },
    { t: 'polyline', points: '5.6 11.4 9.4 7.2 13.6 9.6 19 4.6' },
    { t: 'circle', cx: 9.4, cy: 7.2, r: 0.9 },
    { t: 'circle', cx: 13.6, cy: 9.6, r: 0.9 },
    { t: 'circle', cx: 19, cy: 4.6, r: 0.9 },
  ],
  sliders: [
    { t: 'line', x1: 3.4, y1: 7, x2: 20.6, y2: 7 },
    { t: 'line', x1: 3.4, y1: 12, x2: 20.6, y2: 12 },
    { t: 'line', x1: 3.4, y1: 17, x2: 20.6, y2: 17 },
    { t: 'circle', cx: 8.4, cy: 7, r: 2.2 },
    { t: 'circle', cx: 15.2, cy: 12, r: 2.2 },
    { t: 'circle', cx: 10.6, cy: 17, r: 2.2 },
    { t: 'line', x1: 3.4, y1: 3.4, x2: 3.4, y2: 4.6 },
    { t: 'line', x1: 20.6, y1: 19.4, x2: 20.6, y2: 20.6 },
  ],
};

const NAMES = Object.keys(ICONS);

// The stroke attributes have to sit on an inner <g>, not on the root <svg>:
// SvgView starts inheritance from its own defaults and ignores presentation
// attributes on the root element, so `fill="none"` there would be dropped and
// every stroke icon would paint as a solid blob. This is the same re-rooting
// the `iconSource` adapter does — see docs/ecosystem/icons.md.
const PAINT = {
  fill: 'none',
  stroke: '#2d3436',
  'stroke-width': 1.7,
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
};

const elementToMarkup = (el) => {
  const { t, ...attrs } = el;
  const pairs = Object.entries(attrs)
    .map(([k, v]) => `${k}="${v}"`)
    .join(' ');
  return `<${t} ${pairs}/>`;
};

// Built once per name, not per cell: parsing 400 strings would measure
// htmlparser2 rather than the renderer. SvgNode caches its parsed view per
// node anyway, but sharing the string keeps the first frame honest too.
const SOURCES = Object.fromEntries(
  NAMES.map((name) => {
    const paint = Object.entries(PAINT)
      .map(([k, v]) => `${k}="${v}"`)
      .join(' ');
    const body = ICONS[name].map(elementToMarkup).join('');
    return [
      name,
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g ${paint}>${body}</g></svg>`,
    ];
  }),
);

// --- the cell --------------------------------------------------------------

const s = createStyles({
  window: { backgroundColor: '#f5f6fa' },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingLeft: 12,
    paddingRight: 12,
    height: 30,
    backgroundColor: '#ffffff',
  },
  title: { fontSize: 12, color: '#2d3436', width: 84 },
  hint: { fontSize: 11, color: '#7f8c8d' },
  ctl: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  ctlLabel: { fontSize: 11, color: '#7f8c8d' },
  ctlValue: { fontSize: 11, color: '#2d3436', width: 30 },
  // The viewport: it takes the space the header leaves and lets the wall
  // overflow it. ScrollViewNode supplies the `flex-basis: 0` and the
  // `min-height: 0` that a scroll container always wants, so `flexGrow` is
  // the whole declaration.
  scroller: { flexGrow: 1 },
  // `flexWrap` is the whole point: the column count is a function of the
  // window width, so every resize is a real reflow of all `count` cells
  // rather than a stretch of a fixed grid. The wrap still happens at the
  // viewport width inside the scrollview — what the scroll container took
  // away is `flexGrow`, since in there the wall has to size to its content
  // or there would be nothing to scroll.
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignContent: 'flex-start',
    padding: 6,
  },
  cell: { alignItems: 'center', justifyContent: 'center' },
  glyph: { color: '#2d3436' },
});

function IconCell({ name, mode, size, cell }) {
  const box = { ...s.cell, width: cell, height: cell };

  if (mode === 'text') {
    // The control: one cached glyph where the SVG would be. Same node count,
    // same layout, same damage — a different drawing primitive.
    return (
      <box style={box}>
        <text style={{ ...s.glyph, fontSize: size }}>
          {name.charAt(0).toUpperCase()}
        </text>
      </box>
    );
  }

  if (mode === 'jsx') {
    // Declarative children: every primitive is a real host node reconciled by
    // React, so this mode also pays 400 x ~8 extra nodes in the tree and an
    // SvgView rebuild whenever anything in the subtree changes.
    return (
      <box style={box}>
        <svg viewBox="0 0 24 24" style={{ width: size, height: size }}>
          <g {...PAINT}>
            {ICONS[name].map((el, i) => {
              const { t, ...attrs } = el;
              return React.createElement(t, { key: i, ...attrs });
            })}
          </g>
        </svg>
      </box>
    );
  }

  return (
    <box style={box}>
      <svg source={SOURCES[name]} style={{ width: size, height: size }} />
    </box>
  );
}

// --- the app ---------------------------------------------------------------

const MODES = ['source', 'jsx', 'text'];

const DEFAULT_COUNT = 400;
const DEFAULT_SIZE = 20;

function Control({ label, name, value, min, max, step, onChange }) {
  return (
    <box style={s.ctl}>
      <text style={s.ctlLabel}>{label}</text>
      <Slider
        name={name}
        value={value}
        min={min}
        max={max}
        step={step}
        // the value widgets report a change event, not a bare value
        onChange={(ev) => onChange(ev.value)}
        style={{ width: 120 }}
      />
      <text style={s.ctlValue}>{String(value)}</text>
    </box>
  );
}

// `width`/`height` are props rather than constants so a headless capture can
// size the window to its own server, the way the stress app does.
function App({
  onRoot,
  count: initialCount = DEFAULT_COUNT,
  size: initialSize = DEFAULT_SIZE,
  mode: initialMode = 'source',
  width = 1180,
  height = 820,
}) {
  const [mode, setMode] = useState(initialMode);
  const [count, setCount] = useState(initialCount);
  const [size, setSize] = useState(initialSize);
  const shell = useRef(null);
  const cell = size + 18;

  // Which SVG mode the glyph switch returns to. Kept in a ref rather than
  // state because changing it must never itself cause a render — it is only
  // read at the moment the switch is flipped back off.
  const svgMode = useRef(mode === 'text' ? 'source' : mode);
  if (mode !== 'text') svgMode.current = mode;

  useEffect(() => {
    const root = shell.current?.root;
    if (root) onRoot?.({ root, count, size, mode });
  }, [onRoot, count, size, mode]);

  const cells = [];
  for (let i = 0; i < count; i++) {
    cells.push(
      <IconCell
        key={i}
        name={NAMES[i % NAMES.length]}
        mode={mode}
        size={size}
        cell={cell}
      />,
    );
  }

  return (
    <window
      title={`react-x11 icons — ${count} x ${mode}`}
      width={width}
      height={height}
      minWidth={520}
      minHeight={320}
      style={s.window}
      // 1 and 2 pick between the two SVG routes, which the switch does not
      // cover — it toggles the glyph control, not which SVG mode is behind it
      onKeyDown={(ev) => {
        if (ev.key === '1') setMode('source');
        if (ev.key === '2') setMode('jsx');
      }}
    >
      <box ref={shell} style={{ flexGrow: 1 }}>
        {/* Both sliders start at the values the baseline was measured with, so
            an untouched window reproduces the numbers in the PR. They are the
            only live things in the header on purpose: a frame counter or an
            fps readout here would claim damage every frame and pollute the
            measurement it was describing. Dragging a slider is itself a useful
            stress — every step rebuilds and relays out the whole grid. */}
        <box style={s.head}>
          {/* The comparison the whole example exists for, one flip away:
              off draws each cell as an <svg>, on draws one cached glyph in
              its place. Same grid, same cell count, same damage — only the
              drawing primitive changes, so the two frame logs are directly
              comparable without restarting. */}
          <box style={s.ctl}>
            <Switch
              name="glyphs"
              checked={mode === 'text'}
              onChange={(ev) => setMode(ev.value ? 'text' : svgMode.current)}
            />
            <text style={s.ctlLabel}>glyph control</text>
          </box>
          <text style={s.title}>{mode}</text>
          <Control
            label="count"
            name="count"
            value={count}
            min={50}
            max={1200}
            step={50}
            onChange={setCount}
          />
          <Control
            label="size"
            name="size"
            value={size}
            min={8}
            max={48}
            step={2}
            onChange={setSize}
          />
          <text style={s.hint}>
            drag an edge to reflow · wheel to scroll · 1 source · 2 jsx
          </text>
        </box>
        <scrollview style={s.scroller}>
          <box style={s.grid}>{cells}</box>
        </scrollview>
      </box>
    </window>
  );
}

export default App;

// --- the paint clock -------------------------------------------------------
//
// `flush()` returning tells you only that the frame's requests were *encoded
// and written* — X is asynchronous, so a client that drew a megabyte of
// trapezoids and one that drew nothing both return promptly. The wall time
// around flush() is therefore the client's share, not the frame.
//
// The server's share comes from a **fence**: a request that carries a reply
// (`GetInputFocus` is the traditional cheapest one), issued after the frame's
// drawing. X processes a client's requests strictly in order, so the reply
// cannot come back until the server has executed everything queued ahead of
// it — every AddTraps, every Composite. Its arrival is the moment the last
// drawing request of the frame actually produced pixels.
//
// The fence goes out on a `setImmediate` rather than inline, because ntk
// blits its backing pixmap to the window at the end of the same frame path
// that called flush(); waiting a turn puts that CopyArea ahead of the fence
// too, so `server` covers the whole frame rather than everything-but-the-blit.
// (ntk runs a fence of its own for frame pacing and leaves the result in
// `window.frameLatency` — same technique, different anchor.)
//
// `server` is the tail the client is *still waiting on* once it stops talking,
// not the server's whole share: the two overlap, since the server starts
// executing partway through flush() rather than after it. That makes `total`
// the honest end-to-end figure and `server` a lower bound on the server cost.
//
// What this still does not measure is photons: on a compositing WM the pixels
// then go through the compositor. This is "the X server finished drawing",
// which is the number the renderer can actually act on.
function watchPaint(root, { quiet = 0 } = {}) {
  const X = root.window?.app?.X;
  const original = root.flush.bind(root);
  const hadOwnFlush = Object.hasOwn(root, 'flush');
  let frames = 0;
  let lastReply = 0;
  let clientTotal = 0;
  let serverTotal = 0;
  let measured = 0;
  const queue = [];

  // Write out every leading entry whose server time has been settled (a
  // number, or null for "went unfenced"); stop at the first one still waiting.
  const drain = () => {
    while (queue.length && queue[0].server !== undefined) {
      const e = queue.shift();
      if (e.area < quiet) continue;
      const total = e.server == null ? null : e.client + e.server;
      process.stdout.write(
        `  ${String(e.n).padStart(5)}` +
          `  ${e.where.padEnd(6)}` +
          `  ${(e.area / 1000).toFixed(0).padStart(6)}kpx` +
          `  ${e.client.toFixed(1).padStart(7)}ms` +
          `  ${(e.server == null ? '—' : e.server.toFixed(1)).padStart(7)}ms` +
          `  ${(total == null ? '—' : total.toFixed(1)).padStart(7)}ms` +
          `  ${e.why}\n`,
      );
    }
  };

  root.flush = () => {
    // An animation sets needsPaint from *inside* flush, so sample the flags
    // first: a flush that was never going to paint must not be counted.
    const willPaint =
      root.needsPaint || root.needsLayout || root._animating?.size > 0;
    if (!willPaint) return original();

    const t0 = performance.now();
    const result = original();
    const client = performance.now() - t0;
    if (typeof root.window?.getContext !== 'function') return result; // headless

    frames += 1;
    clientTotal += client;
    const n = frames;
    const rects = root._lastDamageRects;
    const area = rects
      ? rects.reduce((sum, r) => sum + r.width * r.height, 0)
      : (root.window.width ?? 0) * (root.window.height ?? 0);
    const why = root._lastReasons?.join('+') || '';
    const where = rects ? `${rects.length} rect` : 'FULL';

    // A fenced frame's line cannot be written until its reply lands, so lines
    // go through an ordered queue — otherwise a later unfenced frame prints
    // ahead of an earlier fenced one and the log reads backwards.
    const entry = { n, where, area, client, why, server: undefined };
    queue.push(entry);

    if (!X) {
      entry.server = null;
      drain();
      return result;
    }
    // Every frame gets its own fence. Replies come back in request order, so
    // a frame that was queued while the server was still busy with the last
    // one is charged only from the moment the server actually reached it —
    // `max(previous reply, this frame's requests written)`. Without that a
    // backed-up frame would be billed for its predecessor's work too.
    const t1 = performance.now();
    setImmediate(() => {
      X.GetInputFocus(() => {
        const now = performance.now();
        entry.server = now - Math.max(lastReply, t1);
        lastReply = now;
        serverTotal += entry.server;
        measured += 1;
        drain();
      });
    });
    return result;
  };

  return {
    stop() {
      if (hadOwnFlush) root.flush = original;
      else delete root.flush;
    },
    report() {
      if (frames === 0) return 'no frames painted';
      return (
        `${frames} frames · mean client ${(clientTotal / frames).toFixed(1)}ms` +
        (measured
          ? ` · mean server ${(serverTotal / measured).toFixed(1)}ms` +
            ` over ${measured} fenced`
          : '')
      );
    },
  };
}

if (!process.env.REACT_X11_NO_AUTORUN) {
  const arg = (name, fallback) => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
  };
  const count = Number(arg('count', DEFAULT_COUNT));
  const size = Number(arg('size', DEFAULT_SIZE));
  const mode = arg('mode', 'source');
  if (!MODES.includes(mode)) {
    process.stderr.write(`unknown --mode=${mode}, want ${MODES.join('|')}\n`);
    process.exit(1);
  }
  const quiet = process.argv.includes('--quiet') ? 50_000 : 0;

  const root = await createRoot();
  let watcher = null;
  root.render(
    <App
      count={count}
      size={size}
      mode={mode}
      onRoot={({ root: node }) => {
        if (watcher) return;
        watcher = watchPaint(node, { quiet });
        process.stdout.write(
          `\n  drag an edge to reflow · wheel to scroll · the switch swaps` +
            ` svg for the glyph control · sliders change count and size\n\n` +
            `  frame  damage    area    client   server    total  why\n` +
            `  ${'-'.repeat(64)}\n`,
        );
      }}
    />,
  );

  const bye = () => {
    if (watcher) {
      process.stdout.write(`\n  ${watcher.report()}\n\n`);
      watcher.stop();
    }
    process.exit(0);
  };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

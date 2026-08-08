// The rasterization gate, live: a wall of controls repainting every frame,
// and a header that moves ntk's local-vs-server routing while it runs.
//
// ntk decides per drawing whether to rasterize coverage on the client and
// upload it (`PutImage` of an a8 mask) or to hand the shape to the server as
// trapezoids (`Render.AddTraps`/`Trapezoids`) — `routeRaster` in ntk's
// lib/rasterize.js, thresholds in `DEFAULT_RASTER_POLICY`. Those thresholds
// were measured against XQuartz, a pure software server. On a glamor-class
// server the trapezoid path is a software fallback, so the same defaults can
// be 10-40x slower per frame (sidorares/ntk#177). This example exists to
// make that difference visible on *your* server, without patching ntk.
//
// ## The escape hatch it is built on
//
// `createRoot()` forwards only display/stream/fontSource/glxVisual/onXError
// to ntk, so there is no react-x11 option or env var for this yet. But
// `app.rasterPolicy` is a getter that merges `app.options.rasterPolicy` over
// the defaults on *every* routing decision, so assigning to `app.options`
// re-routes the next frame — no reconnect, which is the whole reason this
// can be a slider instead of a benchmark script.
//
//   root.app.options.rasterPolicy = { maxArea: 1 << 20, bytesPerEdge: 10000 };
//   root.app.textPolicy = { vectorFrom: Infinity };  // sibling knob, on the
//                                                    // app, not options
//
// ## What the presets actually do to the wire
//
// Six forced full repaints of the 48-cell wall, counted through
// `startTrace({ sink: 'summary' })` against node-x11's in-process server:
//
//   default         AddTraps  568   PutImage 2052   6.5MB out
//   always local    AddTraps  132   PutImage 3119  14.1MB out
//   always server   AddTraps 1211   PutImage    0   1.6MB out
//
// So the switch is real, and it names the tradeoff: local rasterization
// trades bytes on the socket (which is cheap locally) for trapezoid work in
// the server (which is a software fallback under glamor). The 132 AddTraps
// that survive "always local" do *not* come through `routeRaster` — clip
// masks and the like reach XRender directly — which is worth knowing before
// concluding the gate alone can eliminate the fallback path.
//
// ## The gauge, twice
//
// `routeRaster` is handed a drawing's bounding box and edge count, so the
// two things that decide its answer are how big a drawing is and how many
// edges it carries. The gauge cells put both on the header:
//
//   gauge height       scales the arc, moving `area` — the left-hand side of
//                      *both* comparisons — across the thresholds
//   use svg for gauge  draws the identical arc as a parsed <svg> document
//                      instead of imperative <canvas onDraw> calls
//
// SvgView draws through the same 2d context `onDraw` calls directly, so the
// gate sees the same shapes either way and the switch isolates what the
// frontend itself costs.
//
// Run with: npm run examples:raster-gate  (needs an X server / DISPLAY)
import React, { useEffect, useMemo, useRef, useState } from 'react';

import {
  Button,
  Checkbox,
  ProgressBar,
  Select,
  Slider,
  Switch,
  createRoot,
} from '../src/index.js';
// The renderer's own frame hook — `{ start, end, fence }` after each painted
// frame. `fence` is ntk's GetInputFocus round trip after the frame's
// requests, i.e. how long the server took to *drain* them, and it is the
// number that moves when routing changes: client paint time barely notices
// a software fallback the server is stuck in.
import { hooks as traceHooks } from '../src/trace-registry.js';

// --- policy presets --------------------------------------------------------

// `routeRaster` returns 'server' for `area > maxBytes` before anything else,
// so "always local" still needs a ceiling — 4MB of coverage is far past any
// widget and keeps a stray full-window fill from becoming a 700KB PutImage
// storm. "always server" is thresholds of zero: no drawing clears them.
const PRESETS = {
  'ntk default': null,
  'always local': {
    maxArea: Infinity,
    bytesPerEdge: Infinity,
    maxBytes: 1 << 22,
  },
  'always server': { maxArea: 0, bytesPerEdge: 0, maxBytes: 1 << 22 },
  custom: 'custom',
};

const PRESET_NAMES = Object.keys(PRESETS);

/** What ntk uses when `app.options.rasterPolicy` is unset — shown as the
 * starting point for the custom sliders, so "custom" opens where "default"
 * left off rather than somewhere arbitrary. */
const NTK_DEFAULT = { maxArea: 64 * 64, bytesPerEdge: 150, maxBytes: 1 << 20 };

// --- the wall --------------------------------------------------------------

// One stroked arc plus a needle. Strokes flatten into many edges over a
// small area, which is precisely the shape `bytesPerEdge` arbitrates — a
// rounded rectangle is 14-79 trapezoids, this is hundreds.

const GAUGE_TRACK = '#dfe6e9';
const GAUGE_VALUE = '#0984e3';
const GAUGE_NEEDLE = '#2d3436';

/** The gauge keeps the proportions of the 54x34 it started at, so the height
 * slider grows the *drawing*: `r` below is bounded by half the width, so a
 * gauge that grew in one axis only would stop getting bigger the moment
 * height passed width and would then just slide down a taller box. */
const GAUGE_ASPECT = 54 / 34;

const gaugeWidth = (height) => Math.round(height * GAUGE_ASPECT);

/** Arc centre, radius and needle angle. Shared by both frontends on purpose:
 * the switch is a comparison of two *descriptions* only if the geometry each
 * one describes is the same. */
function gaugeGeometry(width, height, value) {
  const cx = width / 2;
  const cy = height - 4;
  return { cx, cy, r: Math.min(cx, cy) - 3, angle: Math.PI * (1 + value) };
}

/** The gauge as imperative 2d calls: three strokes, three trips through the
 * gate, nothing cached (`<canvas>` caching is opt-in via `cacheKey`). */
function GaugeCanvas({ value, height }) {
  return (
    <canvas
      style={{ width: gaugeWidth(height), height }}
      onDraw={(ctx, info) => {
        const { cx, cy, r, angle } = gaugeGeometry(
          info.width,
          info.height,
          value,
        );
        ctx.lineWidth = 5;
        ctx.strokeStyle = GAUGE_TRACK;
        ctx.beginPath();
        ctx.arc(cx, cy, r, Math.PI, 2 * Math.PI);
        ctx.stroke();
        ctx.strokeStyle = GAUGE_VALUE;
        ctx.beginPath();
        ctx.arc(cx, cy, r, Math.PI, angle);
        ctx.stroke();
        ctx.strokeStyle = GAUGE_NEEDLE;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(
          cx + Math.cos(angle) * r * 0.8,
          cy + Math.sin(angle) * r * 0.8,
        );
        ctx.stroke();
      }}
    />
  );
}

/**
 * The same gauge as a document. `<svg>` children are real nodes, serialized
 * into the DOM ntk's SvgView parses; `viewBox` matching the style box makes
 * the scale exactly 1, so this reaches the gate as the same three shapes.
 *
 * One thing the canvas gauge gets for free and this one has to earn: `<svg>`
 * *is* paint-cached, keyed by the document text (`paintCachePlan` in
 * src/richnodes.js), so a gauge whose value repeated would be composited
 * from a pixmap with the gate never consulted — the same trap the churn
 * switch exists to avoid. Coordinates go in at full float precision for that
 * reason: rounding them to something a human would want to read is exactly
 * what would let two frames share a key.
 */
function GaugeSvg({ value, height }) {
  const width = gaugeWidth(height);
  const { cx, cy, r, angle } = gaugeGeometry(width, height, value);
  // sweep-flag 1 from the left end: in y-down space that is the upper arc
  const arc = (to) =>
    `M${cx - r} ${cy}A${r} ${r} 0 0 1 ${cx + Math.cos(to) * r} ${cy + Math.sin(to) * r}`;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width, height }}>
      <path
        d={arc(2 * Math.PI)}
        fill="none"
        stroke={GAUGE_TRACK}
        strokeWidth={5}
      />
      <path d={arc(angle)} fill="none" stroke={GAUGE_VALUE} strokeWidth={5} />
      <line
        x1={cx}
        y1={cy}
        x2={cx + Math.cos(angle) * r * 0.8}
        y2={cy + Math.sin(angle) * r * 0.8}
        stroke={GAUGE_NEEDLE}
        strokeWidth={2}
      />
    </svg>
  );
}

/**
 * One cell of the wall: a rounded, bordered box (server-side, that is a fill
 * plus trapezoid rasterization per corner) around a control whose value
 * moves. `value` changing every frame is what keeps this honest — react-x11
 * caches painted content by key (src/paintcache.js), and a static wall would
 * be composites of cached pixmaps with the gate never consulted at all.
 */
function Cell({ index, value, gaugeHeight, gaugeSvg }) {
  const kind = index % 4;
  const Gauge = gaugeSvg ? GaugeSvg : GaugeCanvas;
  return (
    <box
      style={{
        width: 148,
        gap: 6,
        padding: 8,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: '$track',
        backgroundColor: '$background',
      }}
    >
      <text style={{ fontSize: 11, color: '$dim' }}>{`#${index}`}</text>
      {kind === 0 && <Gauge value={value} height={gaugeHeight} />}
      {kind === 1 && (
        <Slider value={Math.round(value * 100)} min={0} max={100} />
      )}
      {kind === 2 && (
        <box style={{ gap: 6 }}>
          <ProgressBar value={value} />
          <Checkbox checked={value > 0.5}>on</Checkbox>
        </box>
      )}
      {kind === 3 && (
        <box style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <Switch checked={value > 0.5} />
          <Button>{value > 0.5 ? 'stop' : 'go'}</Button>
        </box>
      )}
    </box>
  );
}

function Wall({ count, phase, gaugeHeight, gaugeSvg }) {
  const cells = [];
  for (let i = 0; i < count; i++) {
    // A per-cell offset so the wall is never uniform: every cell is a
    // different drawing, which is also a different paint-cache key.
    cells.push(
      <Cell
        key={i}
        index={i}
        value={(Math.sin(phase + i * 0.4) + 1) / 2}
        gaugeHeight={gaugeHeight}
        gaugeSvg={gaugeSvg}
      />,
    );
  }
  return (
    <box style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, padding: 8 }}>
      {cells}
    </box>
  );
}

// --- measurement -----------------------------------------------------------

/**
 * Frame stats, sampled from the renderer's frame hook and published four
 * times a second. Not per frame: a `setState` per frame would make the
 * readout itself the load being measured.
 */
function useFrameStats() {
  const [stats, setStats] = useState({ fps: 0, paint: 0, fence: 0, p95: 0 });
  const window = useRef([]);
  useEffect(() => {
    const previous = traceHooks.frame;
    traceHooks.frame = (info) => {
      previous?.(info); // never steal REACT_X11_TRACE's hook
      window.current.push({
        at: info.end,
        paint: info.end - info.start,
        fence: typeof info.fence === 'number' ? info.fence : 0,
      });
    };
    const timer = setInterval(() => {
      const now = performance.now();
      const recent = window.current.filter((s) => now - s.at < 1000);
      window.current = recent;
      if (!recent.length)
        return setStats({ fps: 0, paint: 0, fence: 0, p95: 0 });
      const mean = (pick) =>
        recent.reduce((sum, s) => sum + pick(s), 0) / recent.length;
      const fences = recent.map((s) => s.fence).sort((a, b) => a - b);
      setStats({
        fps: recent.length,
        paint: mean((s) => s.paint),
        fence: mean((s) => s.fence),
        p95: fences[
          Math.min(fences.length - 1, Math.floor(fences.length * 0.95))
        ],
      });
    }, 250);
    return () => {
      clearInterval(timer);
      if (traceHooks.frame) traceHooks.frame = previous;
    };
  }, []);
  return stats;
}

/** Advance `phase` on the window's frame clock while `running`. */
function useChurn(running, windowRef) {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    const wnd = windowRef.current;
    if (!running || !wnd?.requestAnimationFrame) return undefined;
    let cancelled = false;
    let id = 0;
    const tick = () => {
      if (cancelled) return;
      setPhase((p) => p + 0.08);
      id = wnd.requestAnimationFrame(tick);
    };
    id = wnd.requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      wnd.cancelAnimationFrame?.(id);
    };
  }, [running, windowRef]);
  return phase;
}

// --- header ----------------------------------------------------------------

function Field({ label, children }) {
  return (
    <box style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <text style={{ color: '$dim', fontSize: 12 }}>{label}</text>
      {children}
    </box>
  );
}

function Readout({ stats, routing }) {
  const cold = stats.fps === 0;
  return (
    <box
      style={{
        flexDirection: 'row',
        gap: 16,
        padding: 8,
        borderRadius: 6,
        backgroundColor: '$text',
      }}
    >
      <text style={{ color: '$track', fontSize: 12 }}>
        {cold ? 'idle — turn on churn' : `${stats.fps} fps`}
      </text>
      <text style={{ color: '$track', fontSize: 12 }}>
        {`paint ${stats.paint.toFixed(2)}ms`}
      </text>
      <text style={{ color: '$accent', fontSize: 12 }}>
        {`server fence ${stats.fence.toFixed(2)}ms (p95 ${stats.p95.toFixed(1)})`}
      </text>
      <text style={{ color: '$border', fontSize: 12 }}>{routing}</text>
    </box>
  );
}

function App() {
  const windowRef = useRef(null);
  const [preset, setPreset] = useState('ntk default');
  const [maxAreaSide, setMaxAreaSide] = useState(64); // area as a square side
  const [bytesPerEdge, setBytesPerEdge] = useState(150);
  const [vectorText, setVectorText] = useState(true);
  const [churn, setChurn] = useState(true);
  const [count, setCount] = useState(48);
  const [gaugeHeight, setGaugeHeight] = useState(34); // the original 54x34
  const [gaugeSvg, setGaugeSvg] = useState(false);
  const phase = useChurn(churn, windowRef);
  const stats = useFrameStats();

  const policy = useMemo(() => {
    const chosen = PRESETS[preset];
    if (chosen !== 'custom') return chosen;
    return {
      maxArea: maxAreaSide * maxAreaSide,
      bytesPerEdge,
      maxBytes: NTK_DEFAULT.maxBytes,
    };
  }, [preset, maxAreaSide, bytesPerEdge]);

  // The escape hatch, applied. `app.rasterPolicy` merges this over the
  // defaults per decision, so the next frame is already routed the new way —
  // but only for drawings that are actually re-rasterized, hence the cache
  // drop and the full invalidate below.
  useEffect(() => {
    const wnd = windowRef.current;
    const app = wnd?.app;
    if (!app) return;
    if (policy) app.options.rasterPolicy = policy;
    else delete app.options.rasterPolicy;
    app.textPolicy = vectorText ? undefined : { vectorFrom: Infinity };
    // Cached content was rasterized under the old policy and would keep
    // being composited under the new one, which would read as "the switch
    // does nothing". Dropping the cache is what makes the toggle honest.
    app._paintCache?.destroy();
    // Nothing in the React tree changed, so nothing has claimed damage:
    // ask the window node itself for a full repaint.
    wnd._reactX11Node?.invalidate(false);
  }, [policy, vectorText]);

  const routing = policy
    ? `local while area <= max(${policy.maxArea}, ${policy.bytesPerEdge}*edges)`
    : `ntk default (${NTK_DEFAULT.maxArea}, ${NTK_DEFAULT.bytesPerEdge}/edge)`;

  return (
    <window
      ref={windowRef}
      width={1000}
      height={780}
      title="react-x11 — rasterization gate"
      style={{ backgroundColor: '$surfaceHover' }}
      // Without this the WM's close button takes the window away and leaves
      // the process running: `useFrameStats` holds a 250ms interval, which
      // is enough to keep node's event loop alive on its own. Opting into
      // WM_DELETE_WINDOW is what gives the example somewhere to exit from.
      //
      // It says so on the way out, because a silent exit here is
      // indistinguishable from a crash — and under an unhelpful policy this
      // example runs slowly enough that a window manager offering to
      // force-quit it is a real thing that happens.
      onCloseRequest={() => {
        console.log('raster-gate: WM asked the window to close — exiting');
        process.exit(0);
      }}
    >
      <box style={{ padding: 12, gap: 10 }}>
        <text style={{ fontSize: 18, color: '$text' }}>
          Rasterization gate — ntk#177
        </text>
        <box style={{ flexDirection: 'row', gap: 20, alignItems: 'center' }}>
          <Field label="policy">
            <Select
              options={PRESET_NAMES}
              value={preset}
              onChange={(ev) => setPreset(ev.value)}
              style={{ width: 150 }}
            />
          </Field>
          <Field label="churn">
            <Switch checked={churn} onChange={(ev) => setChurn(ev.value)} />
          </Field>
          <Field label="vector text >256px">
            <Switch
              checked={vectorText}
              onChange={(ev) => setVectorText(ev.value)}
            />
          </Field>
          <Field label="cells">
            <Slider
              value={count}
              min={8}
              max={120}
              step={8}
              onChange={(ev) => setCount(ev.value)}
              style={{ width: 130 }}
            />
            <text style={{ color: '$text', fontSize: 12 }}>{`${count}`}</text>
          </Field>
        </box>

        {/* The gauge cells, which are the drawing the gate has the most to
            say about. Height is shown as the box it produces, because that
            product is what `routeRaster` compares against `maxArea`. */}
        <box style={{ flexDirection: 'row', gap: 20, alignItems: 'center' }}>
          <Field label="gauge height">
            <Slider
              value={gaugeHeight}
              min={20}
              max={80}
              step={2}
              onChange={(ev) => setGaugeHeight(ev.value)}
              style={{ width: 180 }}
            />
            <text style={{ color: '$text', fontSize: 12 }}>
              {`${gaugeWidth(gaugeHeight)}×${gaugeHeight} = ${
                gaugeWidth(gaugeHeight) * gaugeHeight
              }px`}
            </text>
          </Field>
          <Field label="use svg for gauge">
            <Switch
              checked={gaugeSvg}
              onChange={(ev) => setGaugeSvg(ev.value)}
            />
          </Field>
        </box>

        {/* Only under "custom": the two thresholds that actually arbitrate,
            `maxBytes` being a ceiling rather than a routing choice. */}
        {preset === 'custom' && (
          <box style={{ flexDirection: 'row', gap: 20, alignItems: 'center' }}>
            <Field label="maxArea side">
              <Slider
                value={maxAreaSide}
                min={0}
                max={1024}
                step={16}
                onChange={(ev) => setMaxAreaSide(ev.value)}
                style={{ width: 180 }}
              />
              <text style={{ color: '$text', fontSize: 12 }}>
                {`${maxAreaSide}² = ${maxAreaSide * maxAreaSide}px`}
              </text>
            </Field>
            <Field label="bytesPerEdge">
              <Slider
                value={bytesPerEdge}
                min={0}
                max={4000}
                step={50}
                onChange={(ev) => setBytesPerEdge(ev.value)}
                style={{ width: 180 }}
              />
              <text
                style={{ color: '$text', fontSize: 12 }}
              >{`${bytesPerEdge}`}</text>
            </Field>
          </box>
        )}

        <Readout stats={stats} routing={routing} />
      </box>

      <box style={{ overflow: 'scroll', flexGrow: 1 }}>
        <Wall
          count={count}
          phase={phase}
          gaugeHeight={gaugeHeight}
          gaugeSvg={gaugeSvg}
        />
      </box>
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<App />);
}

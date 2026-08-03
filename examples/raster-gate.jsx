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

/** A gauge: one stroked arc plus a needle. Strokes flatten into many edges
 * over a small area, which is precisely the shape `bytesPerEdge` arbitrates
 * — a rounded rectangle is 14-79 trapezoids, this is hundreds. */
function Gauge({ value }) {
  return (
    <canvas
      style={{ width: 54, height: 34 }}
      onDraw={(ctx, { width, height }) => {
        const cx = width / 2;
        const cy = height - 4;
        const r = Math.min(cx, cy) - 3;
        ctx.lineWidth = 5;
        ctx.strokeStyle = '#dfe6e9';
        ctx.beginPath();
        ctx.arc(cx, cy, r, Math.PI, 2 * Math.PI);
        ctx.stroke();
        ctx.strokeStyle = '#0984e3';
        ctx.beginPath();
        ctx.arc(cx, cy, r, Math.PI, Math.PI * (1 + value));
        ctx.stroke();
        const a = Math.PI * (1 + value);
        ctx.strokeStyle = '#2d3436';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(a) * r * 0.8, cy + Math.sin(a) * r * 0.8);
        ctx.stroke();
      }}
    />
  );
}

/**
 * One cell of the wall: a rounded, bordered box (server-side, that is a fill
 * plus trapezoid rasterization per corner) around a control whose value
 * moves. `value` changing every frame is what keeps this honest — react-x11
 * caches painted content by key (src/paintcache.js), and a static wall would
 * be composites of cached pixmaps with the gate never consulted at all.
 */
function Cell({ index, value }) {
  const kind = index % 4;
  return (
    <box
      style={{
        width: 148,
        gap: 6,
        padding: 8,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: '#dfe6e9',
        backgroundColor: 'white',
      }}
    >
      <text style={{ fontSize: 11, color: '#7f8c8d' }}>{`#${index}`}</text>
      {kind === 0 && <Gauge value={value} />}
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

function Wall({ count, phase }) {
  const cells = [];
  for (let i = 0; i < count; i++) {
    // A per-cell offset so the wall is never uniform: every cell is a
    // different drawing, which is also a different paint-cache key.
    cells.push(
      <Cell key={i} index={i} value={(Math.sin(phase + i * 0.4) + 1) / 2} />,
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
      <text style={{ color: '#7f8c8d', fontSize: 12 }}>{label}</text>
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
        backgroundColor: '#2d3436',
      }}
    >
      <text style={{ color: '#dfe6e9', fontSize: 12 }}>
        {cold ? 'idle — turn on churn' : `${stats.fps} fps`}
      </text>
      <text style={{ color: '#dfe6e9', fontSize: 12 }}>
        {`paint ${stats.paint.toFixed(2)}ms`}
      </text>
      <text style={{ color: '#74b9ff', fontSize: 12 }}>
        {`server fence ${stats.fence.toFixed(2)}ms (p95 ${stats.p95.toFixed(1)})`}
      </text>
      <text style={{ color: '#b2bec3', fontSize: 12 }}>{routing}</text>
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
      style={{ backgroundColor: '#f5f6fa' }}
    >
      <box style={{ padding: 12, gap: 10 }}>
        <text style={{ fontSize: 18, color: '#2d3436' }}>
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
            <text style={{ color: '#2d3436', fontSize: 12 }}>{`${count}`}</text>
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
              <text style={{ color: '#2d3436', fontSize: 12 }}>
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
                style={{ color: '#2d3436', fontSize: 12 }}
              >{`${bytesPerEdge}`}</text>
            </Field>
          </box>
        )}

        <Readout stats={stats} routing={routing} />
      </box>

      <scrollview style={{ flexGrow: 1 }}>
        <Wall count={count} phase={phase} />
      </scrollview>
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<App />);
}

// The rasterization gate, live: a wall of drawings repainting every frame, a
// header that moves ntk's local-vs-server routing while it runs, and a button
// that measures where the boundary should be on *this* server instead of
// guessing.
//
// ntk decides per drawing whether to rasterize coverage on the client and
// upload it (`PutImage` of an a8 mask) or to hand the shape to the server as
// trapezoids (`Render.AddTraps`) — `routeRaster` in ntk's lib/rasterize.js,
// thresholds in `DEFAULT_RASTER_POLICY`. Those thresholds were measured
// against XQuartz, a pure software server. On a glamor-class server the
// trapezoid path is a software fallback, so the same defaults can be 10-40x
// slower per frame (sidorares/ntk#177). This example exists to make that
// difference visible on your server, without patching ntk.
//
// ## The escape hatch it is built on
//
// `createRoot()` forwards only display/stream/fontSource/glxVisual/onXError
// to ntk, so there is no react-x11 option or env var for this yet. But
// `app.rasterPolicy` is a getter that merges `app.options.rasterPolicy` over
// the defaults on *every* routing decision, so assigning to `app.options`
// re-routes the next frame — no reconnect, which is the whole reason this can
// be a slider instead of a benchmark script.
//
//   root.app.options.rasterPolicy = { maxArea: 1 << 20, bytesPerEdge: 10000 };
//   root.app.textPolicy = { vectorFrom: Infinity };  // sibling knob, on the
//                                                    // app, not options
//
// ## The three knobs that matter, and why they are three
//
// `routeRaster` is handed a drawing's bounding box and its edge count. Those
// are two independent numbers, and a wall that moves them together can only
// ever sweep a diagonal through the space the policy divides. So the load has
// three separate controls, and the probe shape (probe.js) exists to keep them
// from leaking into each other:
//
//   size        the bounding box, 16px to 512px — a checkbox tick to a full
//               illustration. This is `area`, the left-hand side of *both*
//               comparisons `routeRaster` makes.
//   triangles   how complex one drawing is. All of them go into one path and
//               one `fill()`, so this moves `edges` with the box held still.
//   fills       how MANY drawings there are, each identical, each its own
//               `fill()`. The policy does not look at this at all — which is
//               the point. It isolates per-operation cost from per-edge cost,
//               and on a server whose trapezoid path is a fallback, per
//               operation is where the time actually is.
//
// The header prints what the current settings hand the gate — area, edges,
// their ratio, and the answer — next to the fence the frame actually measured.
// Those two agreeing is the example working; them disagreeing is a bug in one
// of us.
//
// ## Auto-calibrate
//
// "calibrate" sweeps a grid of probes, timing each one with the policy pinned
// local and pinned server, and fits the two thresholds to what it measured
// (calibrate.js). It takes about twenty seconds and it answers the question
// this example is otherwise only able to pose. The same sweep runs headless:
//
//   npm run bench:raster -- --json my-machine.json
//
// Run it on two machines and diff the policies; that difference is the
// argument in sidorares/ntk#177, in numbers from your own hardware.
//
// Run with: npm run examples:raster-gate  (needs an X server / DISPLAY)
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  Button,
  Checkbox,
  ProgressBar,
  Select,
  Slider,
  Switch,
  createRoot,
} from '../../src/index.js';
// The renderer's own frame hook — `{ start, end, fence }` after each painted
// frame. `fence` is ntk's GetInputFocus round trip after the frame's requests,
// i.e. how long the server took to *drain* them, and it is the number that
// moves when routing changes: client paint time barely notices a software
// fallback the server is stuck in.
import { hooks as traceHooks } from '../../src/trace-registry.js';
import { fitPolicy, sweep } from './calibrate.js';
import {
  FORCE_LOCAL,
  FORCE_SERVER,
  NTK_DEFAULT,
  drawProbe,
  probeRouting,
} from './probe.js';

// --- policy presets --------------------------------------------------------

const PRESETS = {
  'ntk default': null,
  'always local': FORCE_LOCAL,
  'always server': FORCE_SERVER,
  custom: 'custom',
};

/** Sizes the size slider steps through: geometric, so one slider covers a
 * checkbox tick and a full-window illustration without spending most of its
 * travel between 400 and 512. */
const SIZES = [16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512];

/** Triangle counts, in multiples of 8 — probe.js explains why eight. */
const TRIANGLES = [8, 16, 24, 40, 64, 96, 144, 216, 320, 480];

const nearestIndex = (list, value) =>
  list.reduce(
    (best, v, i) =>
      Math.abs(v - value) < Math.abs(list[best] - value) ? i : best,
    0,
  );

// --- the wall --------------------------------------------------------------

const GAUGE_TRACK = '#dfe6e9';
const GAUGE_VALUE = '#0984e3';
const GAUGE_NEEDLE = '#2d3436';
const PROBE_COLOR = '#0984e3';

/** The gauge keeps the proportions of the 54x34 it started at, so the size
 * slider grows the *drawing*: `r` below is bounded by half the width, and a
 * gauge that grew in one axis only would stop getting bigger the moment
 * height passed width and would then just slide down a taller box. */
const gaugeHeight = (size) => Math.max(12, Math.round((size * 34) / 54));

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
function GaugeCanvas({ value, size }) {
  const height = gaugeHeight(size);
  return (
    <canvas
      style={{ width: size, height }}
      onDraw={(ctx, info) => {
        const { cx, cy, r, angle } = gaugeGeometry(
          info.width,
          info.height,
          value,
        );
        ctx.lineWidth = Math.max(2, Math.round(size / 11));
        ctx.strokeStyle = GAUGE_TRACK;
        ctx.beginPath();
        ctx.arc(cx, cy, r, Math.PI, 2 * Math.PI);
        ctx.stroke();
        ctx.strokeStyle = GAUGE_VALUE;
        ctx.beginPath();
        ctx.arc(cx, cy, r, Math.PI, angle);
        ctx.stroke();
        ctx.strokeStyle = GAUGE_NEEDLE;
        ctx.lineWidth = Math.max(1, Math.round(size / 27));
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
 * src/richnodes.js), so a gauge whose value repeated would be composited from
 * a pixmap with the gate never consulted — the same trap the churn switch
 * exists to avoid. Coordinates go in at full float precision for that reason:
 * rounding them to something a human would want to read is exactly what would
 * let two frames share a key.
 */
function GaugeSvg({ value, size }) {
  const height = gaugeHeight(size);
  const { cx, cy, r, angle } = gaugeGeometry(size, height, value);
  // sweep-flag 1 from the left end: in y-down space that is the upper arc
  const arc = (to) =>
    `M${cx - r} ${cy}A${r} ${r} 0 0 1 ${cx + Math.cos(to) * r} ${cy + Math.sin(to) * r}`;
  return (
    <svg viewBox={`0 0 ${size} ${height}`} style={{ width: size, height }}>
      <path
        d={arc(2 * Math.PI)}
        fill="none"
        stroke={GAUGE_TRACK}
        strokeWidth={Math.max(2, Math.round(size / 11))}
      />
      <path
        d={arc(angle)}
        fill="none"
        stroke={GAUGE_VALUE}
        strokeWidth={Math.max(2, Math.round(size / 11))}
      />
      <line
        x1={cx}
        y1={cy}
        x2={cx + Math.cos(angle) * r * 0.8}
        y2={cy + Math.sin(angle) * r * 0.8}
        stroke={GAUGE_NEEDLE}
        strokeWidth={Math.max(1, Math.round(size / 27))}
      />
    </svg>
  );
}

/**
 * The probe cell: the steerable one. `onDraw` is a fresh closure every render,
 * which is what `CanvasNode.applyProps` watches to claim damage — and there is
 * no `cacheKey`, so nothing between here and the wire can serve this frame
 * from the last one.
 */
function ProbeCell({ size, triangles, fills, phase }) {
  return (
    <canvas
      style={{ width: size, height: size }}
      onDraw={(ctx) =>
        drawProbe(ctx, {
          size,
          triangles,
          fills,
          phase,
          color: PROBE_COLOR,
        })
      }
    />
  );
}

/**
 * One cell of the widget wall: a rounded, bordered box (server-side, that is a
 * fill plus trapezoid rasterization per corner) around a control whose value
 * moves. `value` changing every frame is what keeps this honest — react-x11
 * caches painted content by key (src/paintcache.js), and a static wall would
 * be composites of cached pixmaps with the gate never consulted at all.
 */
function WidgetCell({ index, value, size, gaugeSvg }) {
  const kind = index % 4;
  const Gauge = gaugeSvg ? GaugeSvg : GaugeCanvas;
  return (
    <>
      {kind === 0 && <Gauge value={value} size={size} />}
      {kind === 1 && (
        <Slider
          value={Math.round(value * 100)}
          min={0}
          max={100}
          style={{ width: size }}
        />
      )}
      {kind === 2 && (
        <box style={{ gap: 6, width: size }}>
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
    </>
  );
}

function Cell({
  index,
  value,
  phase,
  shape,
  size,
  triangles,
  fills,
  gaugeSvg,
}) {
  return (
    <box
      style={{
        gap: 6,
        padding: 8,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: '$track',
        backgroundColor: '$background',
      }}
    >
      <text style={{ fontSize: 11, color: '$dim' }}>{`#${index}`}</text>
      {shape === 'probe' ? (
        <ProbeCell
          size={size}
          triangles={triangles}
          fills={fills}
          // a per-cell offset so no two cells draw the same shape — every one
          // is a different drawing, and a different paint-cache key
          phase={phase + index * 0.4}
        />
      ) : (
        <WidgetCell
          index={index}
          value={value}
          size={size}
          gaugeSvg={gaugeSvg}
        />
      )}
    </box>
  );
}

function Wall({ count, phase, shape, size, triangles, fills, gaugeSvg }) {
  const cells = [];
  for (let i = 0; i < count; i++) {
    cells.push(
      <Cell
        key={i}
        index={i}
        value={(Math.sin(phase + i * 0.4) + 1) / 2}
        phase={phase}
        shape={shape}
        size={size}
        triangles={triangles}
        fills={fills}
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
 * Frame stats, sampled from the renderer's frame hook and published four times
 * a second. Not per frame: a `setState` per frame would make the readout
 * itself the load being measured.
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

const Value = ({ children, width }) => (
  <text style={{ color: '$text', fontSize: 12, width }}>{children}</text>
);

/** The theme has no token for "this is the expensive branch" — `accent` means
 * "this is the interactive one" and would read as approval. A literal warm
 * colour, then, and only for the routing verdict and a failed sweep. */
const ALARM = '#e17055';

function Readout({ stats, gate, drawings }) {
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
      {gate && (
        <text
          style={{
            color: gate.route === 'local' ? '$track' : ALARM,
            fontSize: 12,
          }}
        >
          {`${gate.area}px / ${gate.edges} edges = ${Math.round(gate.ratio)} → ${gate.route}`}
        </text>
      )}
      <text style={{ color: '$border', fontSize: 12 }}>
        {`${drawings} drawings/frame`}
      </text>
    </box>
  );
}

/**
 * The calibration strip: a button, a progress bar while it runs, and the
 * fitted policy when it is done.
 *
 * The wall is unmounted for the duration (see App). A sweep that shared the
 * frame clock with an animating wall of 48 canvases would be timing the wall,
 * and it is the one measurement here that has to be clean.
 */
function Calibration({ state, onRun, onApply }) {
  if (state.running) {
    return (
      <box style={{ gap: 6 }}>
        <text style={{ color: '$dim', fontSize: 12 }}>
          {`calibrating — probe ${state.done} of ${state.total}, wall paused`}
        </text>
        <ProgressBar value={state.total ? state.done / state.total : 0} />
      </box>
    );
  }
  return (
    <box style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
      <Button onClick={onRun}>calibrate this server (~20s)</Button>
      {state.error && (
        <text style={{ color: ALARM, fontSize: 12 }}>{state.error}</text>
      )}
      {state.fit && (
        <>
          <text style={{ color: '$text', fontSize: 12 }}>
            {`maxArea ${fmt(state.fit.policy.maxArea)}, bytesPerEdge ${fmt(
              state.fit.policy.bytesPerEdge,
            )} — ${state.fit.speedup.toFixed(1)}x the default over the grid`}
          </text>
          <Button onClick={onApply}>apply</Button>
        </>
      )}
    </box>
  );
}

const fmt = (v) => (Number.isFinite(v) ? String(v) : '∞');

function App() {
  const windowRef = useRef(null);
  const [preset, setPreset] = useState('ntk default');
  const [maxAreaSide, setMaxAreaSide] = useState(64); // area as a square side
  const [bytesPerEdge, setBytesPerEdge] = useState(150);
  const [vectorText, setVectorText] = useState(true);
  const [churn, setChurn] = useState(true);
  const [count, setCount] = useState(48);
  const [shape, setShape] = useState('probe');
  const [sizeIndex, setSizeIndex] = useState(nearestIndex(SIZES, 32));
  const [triIndex, setTriIndex] = useState(nearestIndex(TRIANGLES, 24));
  const [fills, setFills] = useState(1);
  const [gaugeSvg, setGaugeSvg] = useState(false);
  const [calibration, setCalibration] = useState({
    running: false,
    done: 0,
    total: 0,
    fit: null,
    error: null,
  });
  const size = SIZES[sizeIndex];
  const triangles = TRIANGLES[triIndex];
  // the wall is unmounted while calibrating, so the churn clock is stopped
  // too — nothing is animating and the frame hook has nothing to report
  const phase = useChurn(churn && !calibration.running, windowRef);
  const stats = useFrameStats();

  const policy = useMemo(() => {
    if (preset === 'calibrated') return calibration.fit?.policy ?? null;
    const chosen = PRESETS[preset];
    if (chosen !== 'custom') return chosen;
    return {
      maxArea: maxAreaSide * maxAreaSide,
      bytesPerEdge,
      maxBytes: NTK_DEFAULT.maxBytes,
    };
  }, [preset, maxAreaSide, bytesPerEdge, calibration.fit]);

  // The escape hatch, applied. `app.rasterPolicy` merges this over the
  // defaults per decision, so the next frame is already routed the new way —
  // but only for drawings that are actually re-rasterized, hence the cache
  // drop and the full invalidate below.
  useEffect(() => {
    // the sweep owns `app.options.rasterPolicy` while it runs, pinning it
    // local and server in turn; writing over it here would silently corrupt
    // every reading it takes after this render
    if (calibration.running) return;
    const wnd = windowRef.current;
    const app = wnd?.app;
    if (!app) return;
    if (policy) app.options.rasterPolicy = policy;
    else delete app.options.rasterPolicy;
    app.textPolicy = vectorText ? undefined : { vectorFrom: Infinity };
    // Cached content was rasterized under the old policy and would keep being
    // composited under the new one, which would read as "the switch does
    // nothing". Dropping the cache is what makes the toggle honest.
    app._paintCache?.destroy();
    // Nothing in the React tree changed, so nothing has claimed damage: ask
    // the window node itself for a full repaint.
    wnd._reactX11Node?.invalidate(false);
  }, [policy, vectorText, calibration.running]);

  const runCalibration = useCallback(async () => {
    const app = windowRef.current?.app;
    if (!app) return;
    setCalibration({
      running: true,
      done: 0,
      total: 0,
      fit: null,
      error: null,
    });
    try {
      // React renders between probes (the progress bar), so the sweep and the
      // renderer share this thread. That is fine and it is also why the wall
      // is gone: what is left repainting is one progress bar, whose own frame
      // is a few hundred microseconds against a 25ms measurement batch.
      const result = await sweep(app, {
        onProgress: ({ done, total }) =>
          setCalibration((c) => (c.running ? { ...c, done, total } : c)),
      });
      const fit = fitPolicy(result.samples);
      setCalibration({
        running: false,
        done: 0,
        total: 0,
        fit,
        error: null,
      });
    } catch (err) {
      setCalibration({
        running: false,
        done: 0,
        total: 0,
        fit: null,
        error: err.message,
      });
    }
  }, []);

  const presetNames = useMemo(
    () => [...Object.keys(PRESETS), ...(calibration.fit ? ['calibrated'] : [])],
    [calibration.fit],
  );

  const gate = useMemo(
    () =>
      shape === 'probe'
        ? probeRouting(size, triangles, fills, policy ?? NTK_DEFAULT)
        : null,
    [shape, size, triangles, fills, policy],
  );

  return (
    <window
      ref={windowRef}
      width={1080}
      height={820}
      title="react-x11 — rasterization gate"
      style={{ backgroundColor: '$surfaceHover' }}
      // Without this the WM's close button takes the window away and leaves
      // the process running: `useFrameStats` holds a 250ms interval, which is
      // enough to keep node's event loop alive on its own. Opting into
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
              options={presetNames}
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
              style={{ width: 120 }}
            />
            <Value width={30}>{`${count}`}</Value>
          </Field>
        </box>

        {/* The load. `size` and `triangles` are the two numbers routeRaster
            is handed; `fills` is the one it never sees, which is why it has
            to be separate from them. */}
        <box style={{ flexDirection: 'row', gap: 20, alignItems: 'center' }}>
          <Field label="shape">
            <Select
              options={['probe', 'widgets']}
              value={shape}
              onChange={(ev) => setShape(ev.value)}
              style={{ width: 110 }}
            />
          </Field>
          <Field label="size">
            <Slider
              value={sizeIndex}
              min={0}
              max={SIZES.length - 1}
              step={1}
              onChange={(ev) => setSizeIndex(ev.value)}
              style={{ width: 150 }}
            />
            <Value width={72}>{`${size}×${size}px`}</Value>
          </Field>
          {shape === 'probe' ? (
            <>
              <Field label="triangles">
                <Slider
                  value={triIndex}
                  min={0}
                  max={TRIANGLES.length - 1}
                  step={1}
                  onChange={(ev) => setTriIndex(ev.value)}
                  style={{ width: 130 }}
                />
                <Value
                  width={90}
                >{`${triangles} = ${triangles * 3} edges`}</Value>
              </Field>
              <Field label="fills per cell">
                <Slider
                  value={fills}
                  min={1}
                  max={8}
                  step={1}
                  onChange={(ev) => setFills(ev.value)}
                  style={{ width: 90 }}
                />
                <Value width={20}>{`${fills}`}</Value>
              </Field>
            </>
          ) : (
            <Field label="use svg for gauge">
              <Switch
                checked={gaugeSvg}
                onChange={(ev) => setGaugeSvg(ev.value)}
              />
            </Field>
          )}
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
              <Value width={130}>
                {`${maxAreaSide}² = ${maxAreaSide * maxAreaSide}px`}
              </Value>
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
              <Value width={50}>{`${bytesPerEdge}`}</Value>
            </Field>
          </box>
        )}

        <Calibration
          state={calibration}
          onRun={runCalibration}
          onApply={() => setPreset('calibrated')}
        />

        <Readout
          stats={stats}
          gate={gate}
          drawings={shape === 'probe' ? count * fills : count * 3}
        />
      </box>

      <scrollview style={{ flexGrow: 1 }}>
        {calibration.running ? (
          <box style={{ padding: 24 }}>
            <text style={{ color: '$dim', fontSize: 13 }}>
              The wall is unmounted while the sweep runs, so the only thing
              painting is the progress bar above.
            </text>
          </box>
        ) : (
          <Wall
            count={count}
            phase={phase}
            shape={shape}
            size={size}
            triangles={triangles}
            fills={fills}
            gaugeSvg={gaugeSvg}
          />
        )}
      </scrollview>
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<App />);
}

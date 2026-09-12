// 2D over a GL surface — a <glarea>'s children, drawn above it — on a real
// display.
//
//   npm run labs:gl-overlay
//   REACT_X11_BACKEND=x11 npm run labs:gl-overlay       # X11 on macOS
//   LAB_SHOT=/tmp/overlay.png npm run labs:gl-overlay   # one frame, then exit
//
// A surface drawing an equalizer, a frame at a time, with a HUD over it: a
// title card, a legend, a row of buttons and a readout. None of the HUD is
// GL. It is ordinary boxes and text, the children of the <glarea>, which core
// lays out in the surface's box and draws above it (src/gloverlay.js).
// Nothing in the suite can witness that composite — the in-process server
// draws no GL at all, and window capture does not see a GL surface on either
// backend (docs/glx.md) — so this is a lab: run it, and look.
//
// ## What to look at
//
// **The title card is translucent on the Cocoa backend and opaque on X11.**
// It is the one difference between the backends, and the documented one
// (docs/elements.md): Core Animation composites the overlay with the GL
// frame, where an X11 child window cannot be translucent — so there the
// card's half-transparent fill blends with the surface's `clearColor`, and
// the bars stop at its edge.
//
// **The HUD takes the pointer; the surface takes the rest.** The buttons are
// in the overlay. A drag anywhere else on the surface scrubs the bars — the
// surface's own handlers, with `capturePointer()` so the scrub survives the
// pointer leaving the window.
//
// **Hide the legend** and its pane goes; show it and a new one is painted.
// The readout changes once a second, and repaints its own pane and nothing
// else.
//
// ## LAB_SHOT
//
// One frame, reconstructed rather than captured: the GL frame read back with
// `readPixels` inside `onDraw` — the only way there is to see a surface —
// under the window's own pixels and the overlay's, composited the way the
// backend composites them. It needs the direct backend, the one with a
// synchronous `readPixels`: the Cocoa backend, or X11 under a direct `glPolicy`.
// Where the server itself can show GL pixels — Xvfb with `+iglx` — `xwd
// -root` captures the real composite instead.
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { Button, createRoot, createStyles, useApp } from '../../src/index.js';

const BARS = 18;
const shot = process.env.LAB_SHOT || null;
// where LAB_SHOT's frame is drawn: bars 1-4 at 0.77-0.92 of the height
const SHOT_PHASE = -0.08;

/** A bar's colour: cool at the left, warm at the right. */
function barColor(i) {
  const t = i / (BARS - 1);
  return [0.2 + 0.75 * t, 0.55 + 0.3 * Math.sin(t * Math.PI), 0.95 - 0.7 * t];
}

const css = ([r, g, b]) =>
  `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;

/** Where each bar is, in the surface's pixels, bottom-up the way GL counts. */
function bars(width, height, phase) {
  const slot = width / BARS;
  const gap = Math.max(2, Math.round(slot / 6));
  const out = [];
  for (let i = 0; i < BARS; i++) {
    // tall enough to pass under the title card: that is where the two
    // backends' overlays look different
    const level =
      0.6 +
      0.38 * Math.sin(phase + i * 0.55) * Math.cos(phase * 0.37 + i * 0.21);
    out.push({
      x: Math.round(i * slot + gap / 2),
      width: Math.max(1, Math.round(slot - gap)),
      height: Math.round(height * level),
      color: barColor(i),
    });
  }
  return out;
}

/**
 * The frame, in whichever GL this connection has. The two backends are
 * different APIs (docs/gl.md), and bars are the one picture both can draw
 * without a shader: a scissored clear per bar on the direct backend, two
 * triangles per bar in immediate mode on the indirect one, whose context has
 * no scissor.
 */
function drawBars(gl, width, height, phase) {
  const list = bars(width, height, phase);
  if (gl.backend === 'direct') {
    gl.enable(gl.SCISSOR_TEST);
    for (const bar of list) {
      gl.scissor(bar.x, 0, bar.width, bar.height);
      gl.clearColor(...bar.color, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.disable(gl.SCISSOR_TEST);
    return;
  }
  // normalised device coordinates, the matrices left at identity
  const nx = (x) => (x / width) * 2 - 1;
  const ny = (y) => (y / height) * 2 - 1;
  gl.MatrixMode(gl.PROJECTION);
  gl.LoadIdentity();
  gl.MatrixMode(gl.MODELVIEW);
  gl.LoadIdentity();
  gl.Begin(gl.TRIANGLES);
  for (const bar of list) {
    const x0 = nx(bar.x);
    const x1 = nx(bar.x + bar.width);
    const y0 = ny(0);
    const y1 = ny(bar.height);
    gl.Color3f(...bar.color);
    gl.Vertex3f(x0, y0, 0);
    gl.Vertex3f(x1, y0, 0);
    gl.Vertex3f(x1, y1, 0);
    gl.Vertex3f(x0, y0, 0);
    gl.Vertex3f(x1, y1, 0);
    gl.Vertex3f(x0, y1, 0);
  }
  gl.End();
}

/**
 * LAB_SHOT: the display's composite, rebuilt from its three layers — the
 * window's own pixels, the GL frame over the surface's rect, and the
 * overlay's panes over that, alpha-blended the way the backend blends them
 * (an X11 pane is opaque, so its alpha is one). Reaches into the overlay's
 * panes, which is a lab's privilege: there is no public way to read them,
 * and none is needed outside a picture like this one.
 */
async function writeShot(path, area, glPixels) {
  const { writeFileSync } = await import('node:fs');
  const { PNG } = await import('pngjs');
  const wnd = area.root.window;
  const width = wnd.width;
  const height = wnd.height;
  const png = new PNG({ width, height });
  const own = await wnd.getContext('2d').getImageData(0, 0, width, height);
  png.data.set(own.data.subarray(0, width * height * 4));
  // readPixels is bottom-up, a PNG top-down
  const r = area.rect;
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      const src = ((r.height - 1 - y) * r.width + x) * 4;
      const dst = ((r.y + y) * width + (r.x + x)) * 4;
      png.data[dst] = glPixels[src];
      png.data[dst + 1] = glPixels[src + 1];
      png.data[dst + 2] = glPixels[src + 2];
    }
  }
  for (const pane of area._overlay?.panes ?? []) {
    const p = pane.rect;
    const img = await pane.context().getImageData(0, 0, p.width, p.height);
    for (let y = 0; y < p.height; y++) {
      for (let x = 0; x < p.width; x++) {
        const src = (y * p.width + x) * 4;
        const dst = ((p.y + y) * width + (p.x + x)) * 4;
        const a = img.data[src + 3] / 255;
        for (let c = 0; c < 3; c++) {
          png.data[dst + c] = Math.round(
            img.data[src + c] * a + png.data[dst + c] * (1 - a),
          );
        }
      }
    }
  }
  for (let i = 3; i < png.data.length; i += 4) png.data[i] = 255;
  writeFileSync(path, PNG.sync.write(png));
  console.log(
    `wrote ${path} (${width}x${height}): the GL frame (readPixels) under ` +
      'the window’s and the overlay’s own pixels — a reconstruction',
  );
}

const s = createStyles({
  stage: { flexGrow: 1 },
  card: {
    position: 'absolute',
    left: 16,
    top: 16,
    width: 260,
    padding: 12,
    gap: 4,
    borderRadius: 10,
    backgroundColor: 'rgba(255, 255, 255, 0.55)',
  },
  title: { fontSize: 15, color: '#101420' },
  note: { fontSize: 11, color: '#1d2438' },
  legend: {
    position: 'absolute',
    right: 16,
    top: 16,
    padding: 10,
    gap: 6,
    borderRadius: 8,
    backgroundColor: '#f4f5f8',
  },
  swatchRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  swatch: { width: 12, height: 12, borderRadius: 3 },
  label: { fontSize: 11, color: '#1d2438' },
  controls: {
    position: 'absolute',
    left: 16,
    bottom: 16,
    flexDirection: 'row',
    gap: 8,
    padding: 8,
    borderRadius: 8,
    backgroundColor: '#f4f5f8',
  },
  readout: {
    position: 'absolute',
    right: 16,
    bottom: 16,
    padding: 6,
    borderRadius: 6,
    backgroundColor: '#101420',
  },
  readoutText: { fontSize: 11, color: '#e8ecf6' },
});

function Stage() {
  const app = useApp();
  const [paused, setPaused] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [legend, setLegend] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [fps, setFps] = useState(0);
  const clock = useRef({ phase: 0, last: null, frames: 0 });
  const drag = useRef(null);
  const area = useRef(null);
  const shotTaken = useRef(false);
  // The backend composites the overlay itself: the Cocoa backend's pane is a
  // layer Core Animation blends with the frame (src/cocoa/overlay.js).
  const composited = typeof app.createOverlayPane === 'function';

  const onDraw = useCallback(
    (gl, { width, height }) => {
      const c = clock.current;
      const now = performance.now();
      if (c.last !== null && !paused) {
        c.phase += ((now - c.last) / 1000) * 2.4 * speed;
      }
      c.last = now;
      c.frames += 1;
      // The shot's frame is drawn at one phase, the same every run, and one
      // where the bars under the title card stand taller than the card's
      // edge — the difference between the backends is only visible there.
      const shotFrame = shot && !shotTaken.current && c.frames === 90;
      drawBars(gl, width, height, shotFrame ? SHOT_PHASE : c.phase);
      // synchronously, inside the frame: after it, readPixels reads nothing
      if (shotFrame) {
        shotTaken.current = true;
        if (gl.backend !== 'direct') {
          console.error('LAB_SHOT needs the direct backend — see the header');
          process.exit(1);
        }
        const pixels = new Uint8Array(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        writeShot(shot, area.current, pixels).then(
          () => process.exit(0),
          (err) => {
            console.error(err);
            process.exit(1);
          },
        );
      }
    },
    [paused, speed],
  );

  // the readout: once a second, a claim inside the overlay and nowhere else
  useEffect(() => {
    let frames = clock.current.frames;
    let since = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      setFps(
        Math.round(((clock.current.frames - frames) * 1000) / (now - since)),
      );
      frames = clock.current.frames;
      since = now;
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // A press on the HUD bubbles through the surface too: only one on the
  // surface itself starts a scrub.
  const onMouseDown = useCallback((ev) => {
    if (ev.target !== area.current) return;
    ev.capturePointer();
    drag.current = ev.x;
    setDragging(true);
  }, []);
  const onMouseMove = useCallback((ev) => {
    if (drag.current === null) return;
    clock.current.phase += (ev.x - drag.current) * 0.02;
    drag.current = ev.x;
  }, []);
  const onMouseUp = useCallback(() => {
    drag.current = null;
    setDragging(false);
  }, []);

  const togglePause = useCallback(() => {
    // a resumed clock starts from now, not from when it stopped
    clock.current.last = null;
    setPaused((v) => !v);
  }, []);

  return (
    <glarea
      ref={area}
      style={s.stage}
      clearColor="#0e1320"
      frameLoop={paused && !dragging ? 'demand' : 'always'}
      onDraw={onDraw}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
    >
      <box style={s.card}>
        <text style={s.title}>2D over a GL surface</text>
        <text style={s.note}>
          {composited
            ? 'Composited: this card blends with the bars.'
            : 'X11: an opaque pane, on the clear colour.'}
        </text>
        <text style={s.note}>Drag the bars to scrub them.</text>
      </box>
      {legend && (
        <box style={s.legend}>
          {['low', 'mid', 'high'].map((name, k) => (
            <box key={name} style={s.swatchRow}>
              <box
                style={[s.swatch, { backgroundColor: css(barColor(k * 8.5)) }]}
              />
              <text style={s.label}>{name}</text>
            </box>
          ))}
        </box>
      )}
      <box style={s.controls}>
        <Button onPress={togglePause}>{paused ? 'Play' : 'Pause'}</Button>
        <Button onPress={() => setSpeed((v) => (v >= 4 ? 1 : v * 2))}>
          {`Speed ×${speed}`}
        </Button>
        <Button onPress={() => setLegend((v) => !v)}>
          {legend ? 'Hide legend' : 'Show legend'}
        </Button>
      </box>
      <box style={s.readout}>
        <text style={s.readoutText}>{`${fps} fps`}</text>
      </box>
    </glarea>
  );
}

export function App() {
  return (
    <window
      width={720}
      height={440}
      title="2D over a GL surface"
      wmClass="com.example.x11gloverlay"
      style={{ flexGrow: 1, backgroundColor: '#0e1320' }}
    >
      <Stage />
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  // 'auto': direct where there is one, which LAB_SHOT needs, and indirect
  // where there is not — Xvfb with +iglx
  const root = await createRoot({ glPolicy: 'auto' });
  root.render(<App />);
}

// The direct GL backend on a **real** display: shaders, and which pipeline
// drew them.
//
//   npm run labs:direct-gl
//   NTK_GL_POLICY=indirect npm run labs:direct-gl        # the other backend
//   LAB_SHOT=/tmp/gl.png npm run labs:direct-gl          # one frame, then exit
//
// Nothing in the test suite can witness this. `test/glarea.test.js` drives
// node-x11's in-process server with a GLX emulator, so it sees the *indirect*
// command stream and no GPU is involved at any point; the direct backend
// needs a local server, ntk's optional `x11-dri` addon, and hardware. And on
// a real display the surface cannot be *screenshotted* — GL renders where
// `GetImage` cannot reach it (docs/glx.md), which is why `npm run
// screenshots` skips the 3D examples. So this is a lab: run it, look at it,
// read the terminal for the numbers.
//
// ## What it is checking
//
// `examples/viewer3d.jsx` is the *indirect* application — it reports the
// direct backend and deliberately draws nothing on it, because the two are
// different APIs rather than two spellings of one (docs/gl.md). This is the
// other half: the shader path, which exists only on direct.
//
// Direct rendering has two flavors, and `app.glCapabilities().flavor` names
// which one this connection got:
//
//   dri3       Linux — OpenGL ES 2 through EGL/GBM, frames handed to the
//              server as dma-buf descriptors over DRI3 + Present
//   appledri   macOS/XQuartz — the server exports the window's WindowServer
//              surface over the Apple-DRI extension and CGL draws into it
//              (ntk 8.4.0)
//
// Both spell the context the same way — OpenGL ES 2, camelCase, GLSL ES 1.00
// — which is the point of the abstraction and the thing worth confirming by
// hand on each. This file is unchanged between them.
//
// ## Traps this lab exists to catch
//
// **`glPolicy` is what decides, not the machine.** `app.glCapabilities()`
// answers "could direct work here" and says `direct: true` on a capable box
// even under the default `'indirect'` policy — it consults the mode only far
// enough to honour `'off'`. What actually draws is what the policy asked for.
// So this lab reports both, side by side, because a run that reads
// `capabilities.direct = true` and `backend = indirect` is not a bug.
//
// **Nothing can screenshot the surface, but it can read itself back.**
// `GetImage` on the window returns the chrome and a hole where the GL child
// is, because the pixels never live in an X drawable — which is why `npm run
// screenshots` skips the 3D examples. The context is not so limited:
// `gl.readPixels` inside `onDraw` reads the GPU framebuffer directly, and is
// the only way to assert that a shader *rasterized* rather than that its
// calls were accepted. Worth reaching for before concluding a blank window
// means a broken pipeline — `LAB_SHOT` below is that, wired up. It has to be
// called **synchronously** in `onDraw`, though: await anything first and the
// frame completes underneath you, and the read returns zeroes with no error.
//
// **The string queries come back empty.** `gl.getParameter(gl.VERSION)`,
// `RENDERER` and `VENDOR` return `0` rather than strings on the appledri
// flavor, so there is no way to name the GPU from here. Reported below as
// whatever it hands over rather than hidden, since a lab that quietly
// rewrites what it measured is worse than one that shows an empty box.
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { createRoot, useApp, useSupports } from '../../src/index.js';

// A full-screen triangle, and a fragment shader with something moving in it:
// the smallest thing that proves a shader pipeline rather than a clear colour.
const VERTEX_SRC = `
attribute vec2 pos;
varying vec2 v;
void main() {
  v = pos;
  gl_Position = vec4(pos, 0.0, 1.0);
}`;

const FRAGMENT_SRC = `
precision mediump float;
varying vec2 v;
uniform float t;
uniform vec2 res;
void main() {
  vec2 p = v * vec2(res.x / res.y, 1.0);
  float d = length(p);
  float rings = 0.5 + 0.5 * sin(d * 16.0 - t * 2.5);
  float spokes = 0.5 + 0.5 * sin(atan(p.y, p.x) * 6.0 + t);
  vec3 col = mix(vec3(0.10, 0.16, 0.42), vec3(0.35, 0.85, 0.92), rings * spokes);
  gl_FragColor = vec4(col * (1.0 - 0.35 * d), 1.0);
}`;

/** Where to write a single frame and exit, or null to just run. */
const shot = process.env.LAB_SHOT || null;

/**
 * One frame, off the GPU and onto disk.
 *
 * The read has to happen **synchronously inside `onDraw`**, which is why the
 * pixels arrive here as a buffer rather than a context: awaiting anything
 * first — even a dynamic `import` — lets the frame complete, and `readPixels`
 * then returns a screenful of zeroes with no error to say why. That is a
 * black PNG and a long afternoon.
 *
 * `readPixels` is bottom-up where PNG is top-down, so the rows are flipped on
 * the way out. Alpha is forced opaque: the framebuffer has no meaningful
 * alpha and a PNG that claims one renders the shot as a transparent hole in
 * half the viewers there are.
 */
async function writeFrame(pixels, width, height, path) {
  const { writeFileSync } = await import('node:fs');
  const { PNG } = await import('pngjs');

  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * width * 4;
    const dst = y * width * 4;
    for (let x = 0; x < width * 4; x += 4) {
      png.data[dst + x] = pixels[src + x];
      png.data[dst + x + 1] = pixels[src + x + 1];
      png.data[dst + x + 2] = pixels[src + x + 2];
      png.data[dst + x + 3] = 255;
    }
  }
  writeFileSync(path, PNG.sync.write(png));
  console.log(`wrote ${path} (${width}x${height})`);
}

function compile(gl, type, src, what) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`${what} shader: ${gl.getShaderInfoLog(shader)}`);
  }
  return shader;
}

function Lab() {
  const app = useApp();
  const shaders = useSupports('shaders');
  const scene = useRef(null);
  const clock = useRef({ start: Date.now(), frames: 0, lastReport: 0 });

  const [backend, setBackend] = useState(null);
  const [failure, setFailure] = useState(null);
  const [fps, setFps] = useState(0);
  const [caps, setCaps] = useState(null);

  // `glCapabilities()` is idempotent and cached — under a policy that could
  // pick direct, `createRoot()` has already awaited it, so this resolves on
  // the microtask queue rather than costing a round trip.
  useEffect(() => {
    let live = true;
    app.glCapabilities().then(
      (c) => live && setCaps(c),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [app]);

  const onCreated = useCallback((gl) => {
    setBackend(gl.backend ?? 'indirect');
    console.log(`${'backend'.padEnd(24)} ${gl.backend ?? 'indirect'}`);
    if (gl.backend !== 'direct') {
      console.log('this lab draws only on the direct backend — nothing to do');
      return;
    }
    // Strings, or whatever the flavor hands back instead of them.
    for (const name of [
      'VERSION',
      'RENDERER',
      'VENDOR',
      'SHADING_LANGUAGE_VERSION',
    ]) {
      console.log(
        `${name.padEnd(24)} ${JSON.stringify(gl.getParameter(gl[name]))}`,
      );
    }

    const program = gl.createProgram();
    gl.attachShader(
      program,
      compile(gl, gl.VERTEX_SHADER, VERTEX_SRC, 'vertex'),
    );
    gl.attachShader(
      program,
      compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC, 'fragment'),
    );
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`link: ${gl.getProgramInfoLog(program)}`);
    }

    // One vertex buffer on the GPU — the direct backend's whole point, and
    // the thing the indirect protocol encodes no object for.
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    );

    scene.current = {
      program,
      buffer,
      pos: gl.getAttribLocation(program, 'pos'),
      t: gl.getUniformLocation(program, 't'),
      res: gl.getUniformLocation(program, 'res'),
    };
    console.log('shader program linked; drawing');
  }, []);

  const onDraw = useCallback((gl, { width, height }) => {
    const s = scene.current;
    if (!s) return;
    const now = Date.now();
    const t = (now - clock.current.start) / 1000;

    gl.viewport(0, 0, width, height);
    gl.clearColor(0.04, 0.05, 0.09, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(s.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, s.buffer);
    gl.enableVertexAttribArray(s.pos);
    gl.vertexAttribPointer(s.pos, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1f(s.t, t);
    gl.uniform2f(s.res, width, height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Report a rate rather than a frame count: the number that says whether
    // the GPU is doing this or something is falling back.
    const c = clock.current;
    c.frames += 1;
    if (now - c.lastReport >= 1000) {
      const rate = Math.round(c.frames / t);
      setFps(rate);
      c.lastReport = now;
      console.log(`${String(c.frames).padStart(6)} frames  ${rate} fps`);
    }

    // LAB_SHOT: the only way there is to see this surface. Read the frame
    // back off the GPU *before* the swap and write it out — `GetImage` on
    // the window would return the chrome and a hole where this is.
    if (shot && !c.shotDone) {
      c.shotDone = true;
      // Synchronously, while the context is still current — see writeFrame.
      const pixels = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      writeFrame(pixels, width, height, shot).then(
        () => process.exit(0),
        (err) => {
          console.error(err);
          process.exit(1);
        },
      );
    }
  }, []);

  // Where there is no direct backend, say which of the reasons it was: a
  // policy that never asked for it reads differently from a machine that
  // cannot do it, and only one of them is "turn the policy on".
  const onError = useCallback((err) => {
    setFailure(err);
    console.log(`no GL surface: ${err.code ?? 'ERROR'} — ${err.message}`);
    if (err.hint) console.log(err.hint);
  }, []);

  const row = { flexDirection: 'row', gap: 6 };
  const key = { color: '#8b93a7', width: 150 };
  const val = { color: '#e8ecf4' };

  return (
    <box style={{ flexGrow: 1, flexDirection: 'column', padding: 10, gap: 8 }}>
      <box style={{ flexDirection: 'column', gap: 2 }}>
        <box style={row}>
          <text style={key}>policy</text>
          <text style={val}>{app.glPolicy?.mode ?? '—'}</text>
        </box>
        <box style={row}>
          <text style={key}>backend drawn</text>
          <text style={val}>{backend ?? 'starting…'}</text>
        </box>
        <box style={row}>
          <text style={key}>flavor</text>
          <text style={val}>{caps?.flavor ?? '—'}</text>
        </box>
        <box style={row}>
          <text style={key}>machine could</text>
          <text style={val}>{caps ? String(caps.direct) : '—'}</text>
        </box>
        <box style={row}>
          <text style={key}>useSupports</text>
          <text style={val}>{String(shaders)}</text>
        </box>
        <box style={row}>
          <text style={key}>fps</text>
          <text style={val}>{fps ? String(fps) : '—'}</text>
        </box>
      </box>

      {failure ? (
        <box style={{ flexGrow: 1, padding: 10, backgroundColor: '#2b1d1d' }}>
          <text style={{ color: '#ffb4a8' }}>{failure.message}</text>
        </box>
      ) : backend === 'indirect' ? (
        <box style={{ flexGrow: 1, padding: 10, backgroundColor: '#22242c' }}>
          <text style={{ color: '#c9d0e0' }}>
            This connection draws through indirect GLX, which encodes no shader
            objects at all. Run it again under a policy that can pick direct —
            NTK_GL_POLICY=auto — on a machine with the x11-dri addon.
          </text>
        </box>
      ) : (
        <glarea
          style={{ flexGrow: 1 }}
          frameLoop="always"
          onCreated={onCreated}
          onDraw={onDraw}
          onError={onError}
        />
      )}
    </box>
  );
}

function App() {
  return (
    <window
      width={560}
      height={520}
      title="Direct GL — shaders"
      wmClass="com.example.x11directgl"
      style={{ flexGrow: 1, backgroundColor: '#171922' }}
    >
      <Lab />
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  // 'auto' rather than 'direct': the strict form refuses to start at all
  // where direct is unavailable, and this lab's other job is reporting that.
  const root = await createRoot({ glPolicy: 'auto' });
  root.render(<App />);
}

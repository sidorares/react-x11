// Tier D end to end: a GPU-rendered window on a Wayland compositor, with no
// X server anywhere and no pixels on the socket.
//
//   bun examples/wayland-gl.mjs       (or node, with x11-dri >= 0.9)
//
// What it proves, in order: the fd-capable transport connects; xdg-shell
// completes its configure handshake; a GBM buffer exported as a dma-buf is
// accepted by the compositor; and `wl_surface.frame` paces the loop to the
// display rather than to a timer.

import { WaylandConnection } from '../src/wayland/connection.js';
import { WaylandWindow } from '../src/wayland/window.js';
import { WaylandGLContext } from '../src/wayland/glcontext.js';

const VERT = `
attribute vec2 aPos;
varying vec2 vUV;
void main() {
  vUV = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// A plasma, because it makes every pixel the GPU's work and so a stuck frame
// is obvious at a glance.
const FRAG = `
precision mediump float;
varying vec2 vUV;
uniform float uTime;
void main() {
  vec2 p = vUV * 3.0;
  float t = uTime;
  float v = sin(p.x + t) + sin(p.y + t * 0.7)
          + sin((p.x + p.y + t) * 0.7)
          + sin(length(p - 1.5) * 3.0 - t * 1.3);
  v *= 0.25;
  vec3 col = 0.5 + 0.5 * cos(6.2831 * (v + vec3(0.0, 0.33, 0.67)));
  col *= 0.35 + 0.65 * smoothstep(1.0, 0.2, length(vUV - 0.5) * 1.6);
  gl_FragColor = vec4(col, 1.0);
}`;

function compile(gl, type, src, what) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(
      `${what} shader failed to compile: ${gl.getShaderInfoLog(sh)}`,
    );
  }
  return sh;
}

const conn = await WaylandConnection.open();
conn.on('error', (err) => {
  console.error('protocol error:', err.message);
  process.exit(1);
});
console.log(`connected via ${conn.transport}; ${conn.globals.size} globals`);

const window = WaylandWindow.createSync({
  conn,
  compositor: await conn.require('wl_compositor'),
  wmBase: await conn.require('xdg_wm_base'),
  title: 'react-x11 — Wayland, Tier D (GLES over dma-buf)',
  appId: 'react-x11.wayland-gl',
  width: 720,
  height: 480,
});
await window.whenConfigured;
console.log(
  `window configured at ${window.width}x${window.height}, scale ${window.scale}`,
);

const ctx = await WaylandGLContext.create({ conn, window });
const gl = ctx.gl;

// The context has to be current before any GL object is made, and
// `beginFrame` is what makes it so.
ctx.beginFrame();
console.log('GL:', ctx.glVersion?.string);

const prog = gl.createProgram();
gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT, 'vertex'));
gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG, 'fragment'));
gl.linkProgram(prog);
if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
  throw new Error(`program failed to link: ${gl.getProgramInfoLog(prog)}`);
}
const quad = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quad);
gl.bufferData(
  gl.ARRAY_BUFFER,
  new Float32Array([-1, -1, 3, -1, -1, 3]),
  gl.STATIC_DRAW,
);
const aPos = gl.getAttribLocation(prog, 'aPos');
const uTime = gl.getUniformLocation(prog, 'uTime');

let running = true;
window.on('close', () => {
  console.log('\nclose requested');
  running = false;
});
window.on('resize', ({ width, height }) =>
  console.log(`resize -> ${width}x${height}`),
);
window.on('error', (err) => {
  console.error('render error:', err.message);
  running = false;
});

const started = Date.now();
let frames = 0;
let lastReport = started;

while (running) {
  const { width, height } = ctx.beginFrame();
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
  gl.uniform1f(uTime, (Date.now() - started) / 1000);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  // endFrame owns pacing: it queues the frame request, commits, and hands
  // back the clock. See its comment for why the two cannot be separated.
  const vsync = await ctx.endFrame('all');
  frames++;

  const now = Date.now();
  if (now - lastReport >= 1000) {
    process.stdout.write(
      `\r${width}x${height}  ${((frames * 1000) / (now - lastReport)).toFixed(1)} fps  `,
    );
    frames = 0;
    lastReport = now;
  }
  await vsync;
  if (
    process.env.WL_DEMO_FRAMES &&
    Date.now() - started > Number(process.env.WL_DEMO_FRAMES)
  )
    running = false;
}

console.log('\nshutting down');
ctx.destroy();
window.destroy();
conn.destroy();
process.exit(0);

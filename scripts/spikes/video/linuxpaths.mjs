// What a drawn `<video>` frame costs on Linux, per path: the frame from a
// sink into the `<video>`'s surface, synchronised so the work is done and
// not merely queued (design/architecture/video.md §2.5, §2.6, §5).
//
//   X11, JavaScript   frameToRGBA, then putImageData into an ntk Surface
//                     (SHM where it attaches), then a GetInputFocus round trip
//   X11, Xv           the port through a redirected target and one RENDER
//                     copy into the surface (src/xvideo.js), then the round
//                     trip
//   GLES, JavaScript  frameToRGBA, then putImageData into a GL render target,
//                     then glFinish — the Wayland backend's drawn path
//                     without its native write
//   GLES, shader      planes as textures, the matrix in a fragment shader
//                     (src/wayland/video.js), then glFinish
//
// Each row is a format at a size, a hundred frames after ten of warm-up;
// median and p95 milliseconds, and the CPU time of the process per frame.
// The X11 rows need $DISPLAY (Xv needs an image adaptor on it); the GLES
// rows need a render node, and no compositor — the target is offscreen.
//
//   node --import tsx scripts/spikes/video/linuxpaths.mjs
//   node --import tsx scripts/spikes/video/linuxpaths.mjs --frames=300 --sizes=1920x1080
import { createRequire } from 'node:module';

import { createVideoFrames, frameToRGBA } from '../../../src/videoframes.js';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const FRAMES = Number(flag('frames', 100));
const WARMUP = 10;
const SIZES = flag('sizes', '1280x720,1920x1080')
  .split(',')
  .map((s) => s.split('x').map(Number));
const FORMATS = ['NV12', 'I420', 'BGRA'];

/** Two frames of `format` that differ, so no path can skip an unchanged one. */
function framesOf(format, w, h) {
  const make = (shade) => {
    const cw = Math.ceil(w / 2);
    const ch = Math.ceil(h / 2);
    if (format === 'BGRA') return Buffer.alloc(w * h * 4, shade);
    const y = Buffer.alloc(w * h);
    for (let i = 0; i < y.length; i++) y[i] = (i + shade) & 0xff;
    if (format === 'NV12') return [y, Buffer.alloc(cw * 2 * ch, shade)];
    return [
      y,
      Buffer.alloc(cw * ch, shade),
      Buffer.alloc(cw * ch, 255 - shade),
    ];
  };
  return [make(60), make(180)];
}

async function measure(label, step) {
  const times = [];
  const cpu0 = process.cpuUsage();
  for (let i = 0; i < WARMUP + FRAMES; i++) {
    const t0 = performance.now();
    await step(i);
    if (i >= WARMUP) times.push(performance.now() - t0);
  }
  const cpu = process.cpuUsage(cpu0);
  times.sort((a, b) => a - b);
  const at = (q) =>
    times[Math.min(times.length - 1, Math.floor(q * times.length))];
  const cpuMs = (cpu.user + cpu.system) / 1000 / (WARMUP + FRAMES);
  console.log(
    `${label.padEnd(36)} median ${at(0.5).toFixed(2).padStart(6)} ms   ` +
      `p95 ${at(0.95).toFixed(2).padStart(6)} ms   cpu ${cpuMs.toFixed(2).padStart(6)} ms/frame`,
  );
}

async function x11Rows() {
  if (!process.env.DISPLAY) return console.log('X11: no $DISPLAY, skipped');
  const { createClient, Surface } = await import('ntk');
  const app = await createClient();
  const sync = () =>
    new Promise((resolve) => app.X.GetInputFocus(() => resolve()));
  await new Promise((resolve) => app.shm.resolve(resolve));
  console.log(
    `X11 (${process.env.DISPLAY}), MIT-SHM ${app.shm.ready ? 'attached' : 'absent'}`,
  );
  const { xvVideoFor } = await import('../../../src/xvideo.js');
  const writer = xvVideoFor(app);
  writer.prepare();
  await writer._opening;
  const win = app.createWindow({
    x: 0,
    y: 0,
    width: 64,
    height: 64,
    overrideRedirect: true,
  });
  const mapped = new Promise((resolve) => win.once('map', resolve));
  win.map();
  await mapped;
  const node = { root: { window: win } };
  console.log(
    writer.port
      ? `  Xv: ${writer.port.adaptor}, ${writer.port.formats.join(' ')}`
      : '  Xv: none',
  );
  for (const [w, h] of SIZES) {
    for (const format of FORMATS) {
      const sink = createVideoFrames(null, { width: w, height: h, format });
      const frames = framesOf(format, w, h);
      const surface = new Surface(app, { width: w, height: h });
      const rgba = {
        width: w,
        height: h,
        data: new Uint8ClampedArray(w * h * 4),
      };
      await measure(`X11 JavaScript ${format} ${w}x${h}`, async (i) => {
        sink.push(frames[i & 1]);
        frameToRGBA(sink, sink.frame, rgba.data);
        surface.render((ctx) => ctx.putImageData(rgba, 0, 0));
        await sync();
      });
      if (writer.port) {
        const xvSink = createVideoFrames(null, { width: w, height: h, format });
        writer.prepare(xvSink);
        await new Promise((resolve) => setTimeout(resolve, 50));
        let declined = 0;
        await measure(`X11 Xv ${format} ${w}x${h}`, async (i) => {
          xvSink.push(frames[i & 1]);
          if (!writer.writeVideoFrame(surface, xvSink, xvSink.frame, node))
            declined++;
          await sync();
        });
        if (declined)
          console.log(`  (${declined} frames declined by the port)`);
        writer.releaseVideoFrame(surface);
      }
      surface.destroy();
    }
  }
  win.destroy();
  await app.close();
}

async function glesRows() {
  let dri;
  try {
    dri = require('x11-dri');
  } catch {
    return console.log('GLES: no x11-dri, skipped');
  }
  const probe = dri.probe();
  if (!probe.gbm || !probe.egl || !probe.gles)
    return console.log('GLES: no render node, skipped');
  const { WaylandSurface } = await import('../../../src/wayland/surface.js');
  const { writeVideoFrame, releaseVideoFrame } =
    await import('../../../src/wayland/video.js');
  const gpu = new dri.Gpu({
    format: dri.FORMAT.ARGB8888,
    depthSize: 16,
    stencilSize: 8,
  });
  const holder = gpu.createSurface(1, 1);
  gpu.makeCurrent(holder);
  const gl = gpu.gl;
  console.log(`GLES (${gpu.glVersion?.string ?? 'unknown'})`);
  const app = {
    gl,
    fonts: null,
    makeCurrent: () => gpu.makeCurrent(holder),
    rebindWindowTarget() {},
  };
  for (const [w, h] of SIZES) {
    for (const format of FORMATS) {
      const sink = createVideoFrames(null, { width: w, height: h, format });
      const frames = framesOf(format, w, h);
      const surface = new WaylandSurface(app, { width: w, height: h });
      const rgba = {
        width: w,
        height: h,
        data: new Uint8ClampedArray(w * h * 4),
      };
      await measure(`GLES JavaScript ${format} ${w}x${h}`, (i) => {
        sink.push(frames[i & 1]);
        frameToRGBA(sink, sink.frame, rgba.data);
        surface.render((ctx) => ctx.putImageData(rgba, 0, 0));
        gl.finish();
      });
      await measure(`GLES shader ${format} ${w}x${h}`, (i) => {
        sink.push(frames[i & 1]);
        writeVideoFrame(app, surface, sink, sink.frame);
        gl.finish();
      });
      releaseVideoFrame(app, surface);
      surface.destroy();
    }
  }
  gpu.destroy();
}

await x11Rows();
await glesRows();

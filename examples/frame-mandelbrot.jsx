// The pane examples/frame.jsx mounts — in its own process through
// `<Frame>`, or inline for the comparison the example is about. Same file
// either way: a pane module is an ordinary component module, and this one
// says which situation it is in by printing its own pid.
//
// The compute is honest: escape-time Mandelbrot, one synchronous pass over
// every pixel inside `onDraw`. Several hundred milliseconds at pane size,
// blocking whichever process it runs in — which is the point. Watch the
// host's ticker while it runs framed, then inline.
import React, { useCallback } from 'react';

import { isFramed, useFrameClose } from '../src/index.js';

/** Where the interesting parts of the set are: centre + half-width. */
export const VIEWS = [
  { name: 'home', x: -0.6, y: 0, scale: 1.6 },
  { name: 'seahorse valley', x: -0.746, y: 0.11, scale: 0.02 },
  { name: 'elephant valley', x: 0.2755, y: 0.006, scale: 0.01 },
  { name: 'spiral', x: -0.7453, y: 0.1127, scale: 0.0018 },
];

function paint(img, width, height, view, iterations) {
  const data = img.data;
  const aspect = width / height;
  const half = view.scale;
  for (let py = 0; py < height; py++) {
    const ci = view.y + ((py / height) * 2 - 1) * half;
    for (let px = 0; px < width; px++) {
      const cr = view.x + ((px / width) * 2 - 1) * half * aspect;
      let zr = 0;
      let zi = 0;
      let n = 0;
      while (n < iterations && zr * zr + zi * zi <= 4) {
        const next = zr * zr - zi * zi + cr;
        zi = 2 * zr * zi + ci;
        zr = next;
        n++;
      }
      const at = (py * width + px) * 4;
      if (n === iterations) {
        data[at] = 8;
        data[at + 1] = 8;
        data[at + 2] = 24;
      } else {
        // smooth-ish colouring from the escape count alone
        const t = n / 48;
        data[at] = Math.floor(128 + 127 * Math.sin(t));
        data[at + 1] = Math.floor(128 + 127 * Math.sin(t + 2.1));
        data[at + 2] = Math.floor(128 + 127 * Math.sin(t + 4.2));
      }
      data[at + 3] = 255;
    }
  }
}

export default function FractalPane({
  view = VIEWS[0],
  iterations = 400,
  crash = false,
  onStats,
}) {
  if (crash) throw new Error('the pane was asked to crash');
  useFrameClose(() => {
    // the moment to flush anything worth keeping; this pane just says so
    console.log('fractal pane: host let go, exiting');
  });
  const draw = useCallback(
    (ctx, { width, height, node }) => {
      const w = Math.max(1, Math.floor(width));
      const h = Math.max(1, Math.floor(height));
      const started = performance.now();
      const img = ctx.createImageData(w, h);
      paint(img, w, h, view, iterations);
      // putImageData is spec-faithful: not transform-affected, so the
      // node's own origin has to be named (docs/elements.md#canvas)
      ctx.putImageData(img, Math.round(node.abs.x), Math.round(node.abs.y));
      onStats?.({
        ms: Math.round(performance.now() - started),
        pixels: w * h,
        iterations,
        pid: process.pid,
      });
    },
    [view, iterations, onStats],
  );
  const where = isFramed() ? `process ${process.pid}` : 'in-process';
  return (
    <box style={{ flexGrow: 1, padding: 10, gap: 8 }}>
      <text style={{ color: '$textMuted' }}>
        {`${view.name} — ${iterations} iterations — computing in ${where}`}
      </text>
      <canvas onDraw={draw} style={{ flexGrow: 1 }} />
    </box>
  );
}

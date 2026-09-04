// The scroll blit's picture, against the real Cocoa bridge (issue #458).
//
// `test/cocoa-scroll-blit.test.js` pins the same invariant over a fake
// bridge, which is what makes it a CI test: rasters in JS, the natives'
// clamping written out, and no macOS in sight. This is the other half —
// the same comparison over real CoreGraphics contexts, real IOSurfaces and
// a real swapchain, for when the question is whether the *bridge* does what
// the model says it does.
//
//   node --import tsx scripts/cocoa-blit-probe.mjs [frames]
//
// Two windows, the same pane, the same pan sequence. The first keeps
// `scrollRegion`, so its frames blit the surviving band and repaint the
// strips the shift exposed; the second has it deleted, which is how
// nodes.js feature-detects a backend without the fast path, so its frames
// repaint the claim whole. After each present the two backing surfaces are
// read back and compared: the blit is only ever an optimization, so a
// single differing pixel is a bug.
//
// Frames a pan actually meets are mixed in — several pans coalesced into
// one, a frame painted but not presented, a present held or occluded — since
// each of those leaves one buffer of the pair a shift behind if the flip's
// catch-up copy covers the wrong rects.
import React from 'react';

process.env.REACT_X11_NO_AUTORUN = '1';
process.env.REACT_X11_BACKEND = 'cocoa';

const { createRoot } = await import('../src/index.js');
const { Node } = await import('../src/node.js');
const { registerElement } = await import('../src/host.js');

const FRAMES = Number(process.argv[2] ?? 500);

const CELL = 24;
const GAP = 10;
const TINTS = [
  '#4c6ef5',
  '#12b886',
  '#fd7e14',
  '#be4bdb',
  '#e03131',
  '#212529',
];

/** A pane that owns a scene and pans it — the `<Flow>`/`<Map>` shape the
 *  public seam was made for (issue #303). Colours are a pure function of a
 *  cell's place in the scene, so a shifted copy of the last frame and a
 *  repaint at the new offset are the same picture. */
class ProbePane extends Node {
  constructor(props, app) {
    super('blitprobepane', props, app);
    this.ox = 0;
    this.oy = 0;
  }

  pan(dx, dy) {
    if (!dx && !dy) return;
    this.ox += dx;
    this.oy += dy;
    this.scrollContents(this.contentBox(), dx, dy);
  }

  paint(ctx) {
    super.paint(ctx);
    const box = this.contentBox();
    if (!(box.width > 0 && box.height > 0)) return;
    const cell = CELL * this.scale;
    const pitch = (CELL + GAP) * this.scale;
    const damage = this.paintDamage();
    ctx.save();
    ctx.beginPath();
    ctx.rect(box.x, box.y, box.width, box.height);
    ctx.clip();
    const c0 = Math.floor((-this.ox - cell) / pitch);
    const r0 = Math.floor((-this.oy - cell) / pitch);
    for (let r = r0; box.y + this.oy + r * pitch < box.y + box.height; r++) {
      for (let c = c0; box.x + this.ox + c * pitch < box.x + box.width; c++) {
        const x = box.x + this.ox + c * pitch;
        const y = box.y + this.oy + r * pitch;
        // culled against the frame's claim, the way a pane culls tiles: on a
        // blit frame that claim is the strip the shift exposed
        if (
          damage &&
          (x >= damage.x + damage.width ||
            damage.x >= x + cell ||
            y >= damage.y + damage.height ||
            damage.y >= y + cell)
        ) {
          continue;
        }
        ctx.fillStyle =
          TINTS[
            (((r * 7 + c * 3) % TINTS.length) + TINTS.length) % TINTS.length
          ];
        ctx.fillRect(x, y, cell, cell);
      }
    }
    ctx.restore();
  }
}

registerElement('blitprobepane', {
  create: (props, app) => new ProbePane(props, app),
});

const e = React.createElement;
const win = (title) =>
  e(
    'window',
    { width: 300, height: 220, title },
    e('blitprobepane', { style: { flexGrow: 1, backgroundColor: '#ffffff' } }),
  );

const root = await createRoot({ cocoa: { frameInterval: 0 } });
root.render(e(React.Fragment, null, win('blit'), win('repaint')));
await new Promise((resolve) => setTimeout(resolve, 400));

const app = root.app;
const windows = [...app._windows.values()];
if (windows.length !== 2)
  throw new Error(`expected two windows, got ${windows.length}`);
const [blitWnd, plainWnd] = windows;
plainWnd.scrollRegion = null; // a backend without the fast path

const paneOf = (wnd) => {
  const walk = (node) => {
    if (node.kind === 'blitprobepane') return node;
    for (const child of node.children ?? []) {
      const hit = walk(child);
      if (hit) return hit;
    }
    return null;
  };
  return walk(wnd._reactX11Node);
};
const panes = windows.map(paneOf);

let blits = 0;
const native = blitWnd._native;
const scrollSurface = native.scrollSurface.bind(native);
native.scrollSurface = (...args) => {
  const moved = scrollSurface(...args);
  if (moved) blits++;
  return moved;
};

/** The backing surface a window would present next, straight off the bridge. */
const readBack = (wnd) => {
  const buf = native.ctxGetImageData(wnd._surface, 0, 0, wnd.width, wnd.height);
  return Buffer.from(
    Buffer.from(buf.buffer ?? buf, buf.byteOffset ?? 0, buf.length),
  );
};

const frame = () => {
  app._tickFrames();
  app._presentAll();
};

frame();
await new Promise((resolve) => setTimeout(resolve, 150));
frame();

let seed = 20260904;
const rng = () =>
  (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

let worst = 0;
let firstBad = null;
for (let i = 0; i < FRAMES; i++) {
  for (let burst = 0, n = 1 + Math.floor(rng() * 3); burst < n; burst++) {
    const dx = Math.round((rng() * 2 - 1) * 9);
    const dy = Math.round((rng() * 2 - 1) * 7);
    for (const pane of panes) pane.pan(dx, dy);
  }
  const dice = rng();
  if (dice < 0.15) {
    blitWnd._occluded = plainWnd._occluded = true;
    frame();
    blitWnd._occluded = plainWnd._occluded = false;
  } else if (dice < 0.3) {
    blitWnd._holdPresent = plainWnd._holdPresent = true;
    frame();
    blitWnd._holdPresent = plainWnd._holdPresent = false;
  } else if (dice < 0.45) {
    app._tickFrames(); // painted, not presented
  }
  frame();
  const blitted = readBack(blitWnd);
  const painted = readBack(plainWnd);
  let diff = 0;
  for (let k = 0; k < blitted.length; k += 4) {
    if (
      blitted[k] !== painted[k] ||
      blitted[k + 1] !== painted[k + 1] ||
      blitted[k + 2] !== painted[k + 2]
    ) {
      diff++;
    }
  }
  if (diff > worst) worst = diff;
  if (diff && firstBad === null) {
    firstBad = i;
    blitWnd.snapshot('/tmp/cocoa-blit-probe-blit.png');
    plainWnd.snapshot('/tmp/cocoa-blit-probe-repaint.png');
  }
}

const pixels = blitWnd.width * blitWnd.height;
console.log(
  JSON.stringify({
    frames: FRAMES,
    blits,
    pixels,
    worstDiff: worst,
    firstBadFrame: firstBad,
  }),
);
if (firstBad !== null) {
  console.log(
    'the two pictures are in /tmp/cocoa-blit-probe-{blit,repaint}.png',
  );
}
await root.unmount();
process.exit(firstBad === null ? 0 : 1);

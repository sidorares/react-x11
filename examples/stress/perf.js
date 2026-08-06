// Frame instrumentation for the stress app — deliberately *not* rendered
// into the window.
//
// A HUD drawn inside the app is self-defeating for this measurement: the
// stats change every frame, so the HUD itself claims damage every frame and
// the damage rect you are trying to read becomes the union of what you did
// and what the HUD did. So the numbers go to stdout instead, and you watch
// the terminal next to the window.
//
// What is measured here is the renderer's own decision — which region the
// frame repainted — not wire traffic. Requests, bytes and Composite pixels
// come from `npm run bench`, which drives the same paths against an
// in-process server where a byte count means something reproducible.

const fmt = (rects) => {
  if (!rects) return 'FULL WINDOW';
  const one = (r) => `${r.width}x${r.height} @ ${r.x},${r.y}`;
  // A frame paints a list of rects, and the whole point of the list is that it
  // can be smaller than the box around it — so when there is more than one,
  // say how much smaller. `+N%` is what a single box would have cost on top.
  if (rects.length === 1) return one(rects[0]);
  const area = rects.reduce((sum, r) => sum + r.width * r.height, 0);
  const box = boxOf(rects);
  const over = ((box.width * box.height) / area - 1) * 100;
  return `${rects.map(one).join(' + ')}  [box +${over.toFixed(0)}%]`;
};

function boxOf(rects) {
  let { x, y } = rects[0];
  let right = x + rects[0].width;
  let bottom = y + rects[0].height;
  for (const r of rects.slice(1)) {
    x = Math.min(x, r.x);
    y = Math.min(y, r.y);
    right = Math.max(right, r.x + r.width);
    bottom = Math.max(bottom, r.y + r.height);
  }
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * Wrap a WindowNode's `flush()` to log what each painted frame cost.
 *
 * `flush()` is the whole frame: it runs layout if needed, calls
 * `_takeDamage()` (which leaves the rects it settled on in `_lastDamageRects`,
 * null meaning "repainted everything") and then paints. Wrapping it catches
 * every repaint however it was triggered — a React commit, a hover, a caret
 * blink — without the app having to cooperate.
 *
 * A flush with nothing to do returns early and paints nothing, which would
 * otherwise read as a frame that re-reported the *previous* frame's damage.
 * So the paint flags are sampled before calling through, and a flush that
 * was never going to paint is not counted.
 *
 * Returns a handle with `stop()` and `report()`.
 */
export function watchFrames(root, { label = '', quiet = 0 } = {}) {
  // `flush` normally lives on WindowNode.prototype, and wrapping it installs
  // an own property that shadows it. Restoring means *deleting* that property,
  // not assigning the bound copy back: assigning would leave the shadow in
  // place, so `stop()` would not really undo anything and a second
  // watchFrames() would stack a wrapper on a wrapper.
  const hadOwnFlush = Object.hasOwn(root, 'flush');
  const original = root.flush.bind(root);
  let frames = 0;
  let fullFrames = 0;
  let totalArea = 0;
  let totalMs = 0;
  // Runs of identical frames are both the interesting failure and the
  // noisiest thing to print, so collapse them into a count.
  let lastLine = null;
  let repeats = 0;

  const flushRepeats = () => {
    if (repeats > 0) {
      process.stdout.write(`         … ×${repeats + 1}\n`);
      repeats = 0;
    }
  };

  root.flush = () => {
    // needsLayout implies a paint — flush sets needsPaint after laying out —
    // and so does a running animation, which is the case worth spelling out:
    // `_advanceAnimations` sets needsPaint from *inside* flush, so an
    // animation frame arrives here with both flags still false and would go
    // uncounted if this only looked at them.
    const willPaint =
      root.needsPaint || root.needsLayout || root._animating?.size > 0;
    if (!willPaint) return original();

    const started = process.hrtime.bigint();
    const result = original();
    const ms = Number(process.hrtime.bigint() - started) / 1e6;

    // A headless window has no getContext, so flush bailed before painting.
    if (typeof root.window?.getContext !== 'function') return result;

    const rects = root._lastDamageRects;
    const full = {
      width: root.window.width ?? 0,
      height: root.window.height ?? 0,
    };
    const area = rects
      ? rects.reduce((sum, r) => sum + r.width * r.height, 0)
      : full.width * full.height;

    frames += 1;
    if (!rects) fullFrames += 1;
    totalArea += area;
    totalMs += ms;

    if (area >= quiet) {
      // why the frame happened, from invalidate()'s reason argument
      const why = root._lastReasons?.length
        ? `  [${root._lastReasons.join('+')}]`
        : '';
      const line = `${fmt(rects)}  ${(area / 1000).toFixed(1)}kpx  ${ms.toFixed(1)}ms${why}`;
      if (line === lastLine) repeats += 1;
      else {
        flushRepeats();
        process.stdout.write(
          `  ${String(frames).padStart(5)}  ${label}${line}\n`,
        );
        lastLine = line;
      }
    }
    return result;
  };

  return {
    stop() {
      flushRepeats();
      if (hadOwnFlush) root.flush = original;
      else delete root.flush;
    },
    report() {
      flushRepeats();
      if (frames === 0) return 'no frames painted';
      const bounded = frames - fullFrames;
      const pct = ((bounded / frames) * 100).toFixed(0);
      const line = [
        `${frames} frames, ${bounded} bounded (${pct}%), ${fullFrames} full`,
        `mean ${(totalArea / frames / 1000).toFixed(1)}kpx`,
        `mean ${(totalMs / frames).toFixed(2)}ms`,
      ];
      // What the display made of them, where ntk >= 7 can say: the clock in
      // effect, the refresh period it measured, and the vertical blanks that
      // went past without a frame from us. `dropped` is the number to watch
      // when chasing jank — it says the frame was late, which the ms column
      // above can only hint at.
      const wnd = root.window;
      if (wnd?.frameClock) {
        const refresh = wnd.refreshInterval
          ? `${wnd.refreshInterval.toFixed(1)}ms (${(1000 / wnd.refreshInterval).toFixed(0)}Hz)`
          : 'unmeasured';
        line.push(`clock ${wnd.frameClock}, refresh ${refresh}`);
        if (wnd.droppedFrames) line.push(`${wnd.droppedFrames} dropped`);
      }
      return line.join(' · ');
    },
    get frames() {
      return frames;
    },
    get fullFrames() {
      return fullFrames;
    },
  };
}

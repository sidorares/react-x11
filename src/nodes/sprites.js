// Sprites (issue #819): the parts of what an element draws that a retained
// presenter may lift onto layers of their own, and animate there in the
// render server. The element's half of the seam is here; the presenter's is
// src/cocoa/sprites.js, under layer promotion.
//
// It is the shape of `opaqueRect()`: an accessor core asks every frame, a
// registry of the nodes that override it (`WindowNode._spriteNodes`, kept by
// `_setRoot`), and a default that answers nothing, so an element that never
// heard of sprites pays nothing and one that answers them draws exactly what
// it draws today wherever nothing asks — on X11, on Wayland, on the layer
// presenter, and in any frame whose scene refuses a lift.

/** Node's half of sprites, installed onto `Node.prototype` by node.js. */
export class NodeSprites {
  /**
   * The parts of this element's drawing a presenter may put on layers of
   * their own, or null, the default. Each is a plain object:
   *
   * - `key`: a string, the same across frames for the same part.
   * - `rect`: its box, untransformed — device pixels, window coordinates,
   *   like `abs`.
   * - `reach`: what it draws, untransformed, when that is more than `rect`.
   * - `paint(ctx)`: draws it where it is in the window, as `paint` would,
   *   but at opacity 1 and untransformed: the layer carries both.
   * - `version`: compared with `===` from frame to frame; a change paints
   *   the part again. Left out, it is painted once.
   * - `opacity`, and `transform` — CSS's `matrix(a, b, c, d, e, f)` as an
   *   array, `e` and `f` in device pixels, or `matrix3d()`'s sixteen
   *   numbers for a part turned out of the plane and seen in a perspective
   *   — about `origin`, a point in device pixels that defaults to `rect`'s
   *   centre: the values the layer shows when no animation is running on
   *   it. A matrix3d part is lifted only where none of its corners is behind
   *   the viewer, at rest or in any keyframe.
   * - `animations`: what the render server runs on it, each `{ id,
   *   property: 'opacity' | 'transform', values, keyTimes, timings,
   *   duration, delay, repeat, autoreverse, hold }`, with times in
   *   milliseconds and `delay` counted from the frame that asks — negative
   *   for one that started before it. An animation is attached once per
   *   `id`: to change one, give it a new id.
   *
   * Asked every frame, after layout and before the damage is taken, on a
   * window whose presenter lifts sprites; nowhere else. An element whose
   * parts changed while nothing was going to paint asks for that frame with
   * `spritesChanged()`.
   */
  sprites() {
    return null;
  }

  /**
   * The keys of this element's sprites that are on layers of their own now,
   * a set the element may keep. Called in the frame that changes it, before
   * that frame paints. From then on `paint` must not draw a lifted part —
   * where it is, the window's bitmap holds a hole the layer shows through —
   * and must draw again one the set no longer holds: a presenter gives a
   * part back whenever the scene stops allowing it, and the bitmap under it
   * is repainted in that same frame.
   */
  spritesLifted(keys) {}

  /**
   * The render server is done with animation `id` on sprite `key`: it ran
   * out (`finished`), or it was taken off with its layer. Called from the
   * backend's event, between frames.
   */
  spriteAnimationEnded(key, id, finished) {}

  /**
   * Ask for the frame in which this element's sprites are asked for again —
   * one whose parts changed while nothing it drew had. Does nothing on a
   * window whose presenter lifts none.
   */
  spritesChanged() {
    this.root?.window?.spritesChanged?.(this);
  }
}

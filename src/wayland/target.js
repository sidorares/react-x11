// A render target: a framebuffer object with a colour texture behind it, and
// a depth/stencil renderbuffer when asked for one.
//
// This is what makes the Wayland backend's painting model the same as the
// X11 one's. An XRender context draws at a pixmap that persists — a partial
// repaint changes some pixels and leaves the rest — and react-x11's whole
// dirty-rectangle architecture assumes exactly that. A GBM swapchain does
// not offer it: buffers rotate, and the one a frame draws into last showed
// the frame before last, so a partial repaint into it leaves stale pixels
// everywhere it did not touch. Drawing into a persistent target instead, and
// copying the changed rectangles into whichever buffer comes round, is what
// lets the renderer's partial repaints be correct without it knowing.
//
// The same object is an offscreen surface — `app.createSurface()`, the paint
// cache, scroll blits — because that is all an offscreen surface is: pixels
// that persist and can be drawn into and sampled from. One class, no special
// cases.
//
// The stencil attachment is what arbitrary paths fill through
// (stencil-then-cover in context2d.js). Putting it on the target rather than
// asking EGL for it means the window's own config no longer has to carry
// stencil bits at all; the request in glcontext.js stays as belt and braces.

export class GLTarget {
  /**
   * @param {object} gl the GLES entry points
   * @param {object} opts
   * @param {number} opts.width
   * @param {number} opts.height
   * @param {boolean} [opts.stencil=true] attach a DEPTH24_STENCIL8 renderbuffer
   * @param {'argb32'|'a8'} [opts.format='argb32']
   */
  constructor(gl, { width, height, stencil = true, format = 'argb32' } = {}) {
    this.gl = gl;
    this.width = 0;
    this.height = 0;
    this.format = format;
    this.wantStencil = stencil;
    this.fbo = null;
    this.texture = null;
    this.depthStencil = null;
    this.destroyed = false;
    this.resize(width, height);
  }

  /**
   * Reallocate at a new size. Contents are lost: the caller that needs the
   * old pixels (a window being resized) copies them across first, and the
   * ones that do not (the paint cache) simply repaint.
   */
  resize(width, height) {
    const gl = this.gl;
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    if (w === this.width && h === this.height && this.fbo) return false;
    this.width = w;
    this.height = h;

    if (!this.texture) this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // Always RGBA8. An 'a8' surface is a coverage mask and could be R8, but
    // the 2d context has one glyph/mask path, over R8 atlases; the memory
    // difference is not worth a second shader mode.
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      w,
      h,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );

    if (!this.fbo) this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this.texture,
      0,
    );
    if (this.wantStencil) {
      if (!this.depthStencil) this.depthStencil = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.depthStencil);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, w, h);
      gl.framebufferRenderbuffer(
        gl.FRAMEBUFFER,
        gl.DEPTH_STENCIL_ATTACHMENT,
        gl.RENDERBUFFER,
        this.depthStencil,
      );
    }
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(
        `could not build a ${w}x${h} render target: framebuffer status 0x${status.toString(16)}`,
      );
    }
    // Fresh storage has undefined contents; a surface starts transparent.
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(
      gl.COLOR_BUFFER_BIT | (this.wantStencil ? gl.STENCIL_BUFFER_BIT : 0),
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return true;
  }

  /** Route draws here and size the viewport to match. */
  bind() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.width, this.height);
  }

  /**
   * Copy rectangles of this target into the framebuffer currently bound for
   * drawing (the swapchain buffer, or another target's fbo).
   *
   * Both are y-down as far as everyone above this line is concerned; GL is
   * y-up, and since source and destination are flipped the same way, a
   * same-orientation blit is a straight copy of the same rows. `rects` null
   * means everything.
   */
  blitTo(drawFbo, rects, dstWidth = this.width, dstHeight = this.height) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, drawFbo);
    gl.disable(gl.SCISSOR_TEST);
    const list = rects ?? [
      { x: 0, y: 0, width: this.width, height: this.height },
    ];
    for (const r of list) {
      const x0 = Math.max(0, Math.floor(r.x));
      const y0 = Math.max(0, Math.floor(r.y));
      const x1 = Math.min(this.width, dstWidth, Math.ceil(r.x + r.width));
      const y1 = Math.min(this.height, dstHeight, Math.ceil(r.y + r.height));
      if (x1 <= x0 || y1 <= y0) continue;
      // Texture row 0 is GL's bottom; our row 0 is the top. The target was
      // drawn with the same convention as the swapchain buffer will be read
      // with, so the GL-space rectangle is the same on both sides.
      const gy0 = this.height - y1;
      const gy1 = this.height - y0;
      const dgy0 = dstHeight - y1;
      const dgy1 = dstHeight - y0;
      gl.blitFramebuffer(
        x0,
        gy0,
        x1,
        gy1,
        x0,
        dgy0,
        x1,
        dgy1,
        gl.COLOR_BUFFER_BIT,
        gl.NEAREST,
      );
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * Shift a band of pixels in place — the scroll blit. Answers whether a
   * copy was made; false means nothing survives the shift and the caller
   * repaints as it would have anyway.
   *
   * Same contract as ntk's `Surface.copyWithin` (ntk#252): integer deltas
   * only, the band is `src ∩ (src + delta)`, nothing outside `src` written.
   * `glBlitFramebuffer` with overlapping source and destination on the same
   * framebuffer is undefined, so this goes through a scratch texture: copy
   * the surviving band out, then blit it back shifted.
   */
  copyWithin(src, dx, dy) {
    if (this.destroyed) return false;
    if (!Number.isInteger(dx) || !Number.isInteger(dy)) return false;
    if (dx === 0 && dy === 0) return false;
    const x0 = Math.max(0, Math.floor(src.x));
    const y0 = Math.max(0, Math.floor(src.y));
    const x1 = Math.min(this.width, Math.ceil(src.x + src.width));
    const y1 = Math.min(this.height, Math.ceil(src.y + src.height));
    const dstX0 = Math.max(x0, x0 + dx);
    const dstY0 = Math.max(y0, y0 + dy);
    const dstX1 = Math.min(x1, x1 + dx);
    const dstY1 = Math.min(y1, y1 + dy);
    if (!(dstX1 > dstX0 && dstY1 > dstY0)) return false;
    const bw = dstX1 - dstX0;
    const bh = dstY1 - dstY0;
    const sx = dstX0 - dx;
    const sy = dstY0 - dy;

    const gl = this.gl;
    const scratch = scratchFor(gl, bw, bh);
    // out: this[sx,sy,bw,bh] -> scratch[0,0]
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, scratch.fbo);
    gl.disable(gl.SCISSOR_TEST);
    gl.blitFramebuffer(
      sx,
      this.height - (sy + bh),
      sx + bw,
      this.height - sy,
      0,
      scratch.height - bh,
      bw,
      scratch.height,
      gl.COLOR_BUFFER_BIT,
      gl.NEAREST,
    );
    // back: scratch[0,0,bw,bh] -> this[dstX0,dstY0]
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, scratch.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.fbo);
    gl.blitFramebuffer(
      0,
      scratch.height - bh,
      bw,
      scratch.height,
      dstX0,
      this.height - (dstY0 + bh),
      dstX0 + bw,
      this.height - dstY0,
      gl.COLOR_BUFFER_BIT,
      gl.NEAREST,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return true;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    const gl = this.gl;
    if (this.fbo) gl.deleteFramebuffer(this.fbo);
    if (this.texture) gl.deleteTexture(this.texture);
    if (this.depthStencil) gl.deleteRenderbuffer(this.depthStencil);
    this.fbo = this.texture = this.depthStencil = null;
  }
}

/**
 * One shared scratch target per GL context for `copyWithin`, grown to the
 * largest band asked for. A scroll happens every frame of a fling; allocating
 * per call would be the wrong trade.
 */
const scratches = new WeakMap();

function scratchFor(gl, w, h) {
  let s = scratches.get(gl);
  if (!s || s.width < w || s.height < h) {
    const nw = Math.max(w, s?.width ?? 0);
    const nh = Math.max(h, s?.height ?? 0);
    s?.destroy();
    s = new GLTarget(gl, { width: nw, height: nh, stencil: false });
    scratches.set(gl, s);
  }
  return s;
}

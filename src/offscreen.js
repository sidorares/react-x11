// An offscreen surface on whichever backend an app is — what the paint cache,
// a group's opacity and the symbol icons draw into, and what `react-x11/ntk`
// hands a component as `Surface`.
//
// An app that makes its own surfaces answers `createSurface(options)` — the
// Cocoa app over a CG bitmap (src/cocoa/surface.js), the Windows app over a
// Direct2D bitmap, the Wayland app over a GL render target
// (src/wayland/surface.js) — and an X connection has no such method and gets
// ntk's pixmap, from ntk's root, which only an X connection loads
// (src/ntkroot.js). The result is whichever implementation answered, not an
// instance of this class: the contract is the shape — `width`/`height`,
// `getContext('2d')`, `render`, `clear`, `copyWithin`, `destroy`, and
// `ctx.drawImage(surface, …)` — (docs/extending.md "Scrolling the pixels, not
// just the offset"), and nothing needs `instanceof`.
//
// Part of that shape is that a context may be **held**: ntk tells a caller
// doing many draws to take `getContext('2d')` once rather than one per frame,
// and that holds on every backend here, including the ones where a surface is
// a GPU target sharing a device with the window (#566). Draws through a held
// context land in the surface whenever they are made, and leave nothing for
// the caller to restore; `render(fn)` is the scoped form, for a caller that
// wants a frame's clean transform and clip.
import { x11Ntk } from './ntkroot.js';

export class Surface {
  constructor(app, options) {
    if (typeof app?.createSurface === 'function') {
      return app.createSurface(options);
    }
    const { Surface: NtkSurface } = x11Ntk('an offscreen surface');
    return new NtkSurface(app, options);
  }
}

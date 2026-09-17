// SF Symbols for the Cocoa backend (#591): `app.symbols`, the provider
// `<image src={{ symbol }}>` asks (src/symbols.js), over `@windowkit/appkit`'s
// `symbolSize` and `ctxDrawSymbol` (0.12.0).
//
// A symbol is a template — its shape, in whatever colour it is drawn with —
// so it is drawn the way a glyph run is: in the context's fill colour, through
// its transform and clip. Sizes are points, which on this backend are logical
// pixels.

import { warnOnce } from '../symbols.js';

export class CocoaSymbols {
  constructor(native) {
    this.native = native;
    this.sizes = new Map(); // name and options -> { width, height } | null
  }

  /** Whether the bridge draws symbols at all. Without the verbs nothing is
   *  shown and nothing else goes wrong, so development says so, once. */
  _available() {
    if (typeof this.native?.ctxDrawSymbol === 'function') return true;
    warnOnce(
      'react-x11: this @windowkit/appkit has no ctxDrawSymbol, so <image ' +
        'src={{ symbol }}> shows nothing on the Cocoa backend. Update ' +
        '@windowkit/appkit to the version react-x11 lists in its ' +
        'optionalDependencies.',
    );
    return false;
  }

  size(name, options) {
    if (!this._available()) return null;
    const bridge = bridgeOptions(options);
    const key = JSON.stringify([name, bridge]);
    if (!this.sizes.has(key)) {
      if (this.sizes.size > 512) this.sizes.clear();
      this.sizes.set(key, this.native.symbolSize(name, bridge));
    }
    return this.sizes.get(key);
  }

  draw(ctx, name, rect, options) {
    if (typeof ctx.drawSymbol !== 'function' || !this._available()) {
      return false;
    }
    ctx.fillStyle = options.color;
    return ctx.drawSymbol(
      name,
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      bridgeOptions(options),
    );
  }
}

/** What the bridge is handed: the options it knows, and only those set. */
const bridgeOptions = ({ pointSize, weight, scale, variableValue }) => ({
  pointSize,
  weight,
  ...(scale === undefined ? {} : { scale }),
  ...(variableValue === undefined ? {} : { variableValue }),
});

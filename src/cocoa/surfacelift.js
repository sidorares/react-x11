// A `LayerSurface`'s frames on a layer of their own (src/layersurface.js):
// what the surface presenter's sprites (src/cocoa/sprites.js) do with a part
// whose `contents` is one. The frames are IOSurface-backed bitmaps the
// element drew into; showing one is repointing the layer at it, inside the
// `draw()` that made it — a layer change of its own, with no react-x11
// frame and no copy of the pixels.

/** Has `native` the verbs a lifted layer surface needs? */
export function canLiftSurface(native) {
  return (
    typeof native?.createSurfaceIOSurface === 'function' &&
    typeof native.setLayerContentsIOSurface === 'function'
  );
}

export class SurfaceLift {
  constructor(native, source, layer) {
    this.native = native;
    this.source = source;
    this.layer = layer;
    this.shown = null;
    this.released = false;
    this._unsubscribe = source._subscribe((frame) => this._show(frame));
    if (source.current) this._show(source.current);
  }

  _show(frame) {
    if (this.released || frame === null || frame.iosurfaceId == null) return;
    if (frame === this.shown) return;
    this.native.setLayerContentsIOSurface(this.layer, frame.iosurfaceId);
    this.shown = frame;
  }

  release() {
    if (this.released) return;
    this.released = true;
    this._unsubscribe();
    this.shown = null;
  }
}

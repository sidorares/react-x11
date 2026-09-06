// The retained layer presenter (src/cocoa/presenter.js) over a recording
// bridge, for a test mounted through the mock harness: the node tree, its
// layout and the invalidate channel are the real ones, and only the Core
// Animation bridge is faked, so what a test pins is the call that goes out.
import { cssColorStraight } from 'ntk';

import { CocoaLayerPresenter } from '../../src/cocoa/presenter.js';

/** A bridge that records every call and answers the few that need a handle. */
export function fakeBridge() {
  const calls = [];
  let surfaces = 0;
  let presentation = null; // what presentationValue answers
  const native = new Proxy(
    {},
    {
      get(_, name) {
        if (typeof name !== 'string') return undefined;
        return (...args) => {
          calls.push({ name, args });
          if (name.startsWith('create') && name.endsWith('Layer')) {
            return { layer: calls.length };
          }
          if (name === 'presentationValue') return presentation;
          if (name === 'createSurface') {
            return { surface: ++surfaces, width: args[0], height: args[1] };
          }
          if (name === 'surfaceSize') {
            return { width: args[0].width, height: args[0].height };
          }
          return undefined;
        };
      },
    },
  );
  return {
    native,
    calls,
    setPresentation: (value) => {
      presentation = value;
    },
    /** The arguments after the surface handle, per call of `name`. */
    argsOf: (name) =>
      calls.filter((c) => c.name === name).map((c) => c.args.slice(1)),
    uploads: () => calls.filter((c) => c.name === 'surfaceToLayer').length,
  };
}

/** The presenter over a fake cocoa window, wired to the mounted tree's
 * invalidate channel the way src/cocoa/window.js wires it in layers mode. */
export function presenterFor({ windowNode, app }) {
  const bridge = fakeBridge();
  const presenter = new CocoaLayerPresenter({
    _native: bridge.native,
    scale: 1,
    app: {
      fonts: app.fonts,
      _parseColor: (c) => cssColorStraight(String(c)),
      _animationEnds: new Map(),
    },
    _layer: { layer: 'root' },
  });
  windowNode.window.noteInvalidate = (damage, layoutChanged) =>
    presenter.noteInvalidate(damage, layoutChanged);
  return { presenter, bridge };
}

/** …and with the animation seam too — `animateNode`/`cancelNodeAnimation`
 * on the window — so a transition or a loop the presenter can take is taken,
 * as it is in layers mode. */
export function animatingPresenterFor(mounted) {
  const { presenter, bridge } = presenterFor(mounted);
  const wnd = mounted.windowNode.window;
  wnd.animateNode = (node, prop, entry) => presenter.animate(node, prop, entry);
  wnd.cancelNodeAnimation = (node, prop) => presenter.cancel(node, prop);
  return { presenter, bridge };
}

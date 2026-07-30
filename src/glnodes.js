// <glarea>: the one drawn element that owns a real X window.
//
// GLX needs a drawable created for a GL-capable visual, and GL output cannot
// share the parent window's XRender pipeline — so this is a child X window
// (NEXT_STEPS §4), sized and positioned by the parent's yoga layout like any
// other drawn node. Everything about the surface is here; the scene graph
// that draws into it comes later (docs/glx-plan.md).
import { cssColorStraight } from 'ntk';

import { Node } from './nodes.js';
import { ScenePointer, sceneWantsPointer } from './pointer3d.js';
import { SceneRenderer } from './scene3d.js';

// One visual query per (app, spec): GetFBConfigs is a round trip and every
// <glarea> in an app wants the same answer.
const configCache = new WeakMap();

export function glxConfig(app, spec) {
  const key = JSON.stringify(spec ?? null);
  let perApp = configCache.get(app);
  if (!perApp) configCache.set(app, (perApp = new Map()));
  let promise = perApp.get(key);
  if (!promise) {
    promise =
      typeof app.chooseGLXConfig === 'function'
        ? app.chooseGLXConfig(spec)
        : Promise.reject(
            new Error(
              'react-x11: <glarea> needs ntk >= 3.6.0 (app.chooseGLXConfig)',
            ),
          );
    perApp.set(key, promise);
  }
  return promise;
}

/**
 * clearColor as a CSS string or an [r, g, b, a] float tuple.
 *
 * Straight alpha, not premultiplied: this goes to `glClearColor`, and GL
 * takes unassociated components. ntk's `cssColor` premultiplies for XRender,
 * which would darken any translucent clear colour.
 */
function clearColorOf(props) {
  const value = props.clearColor ?? 'black';
  if (Array.isArray(value)) return value.length === 4 ? value : [...value, 1];
  const parsed = cssColorStraight(value);
  return parsed ?? [0, 0, 0, 1];
}

const px = (v) => Math.max(1, Math.round(v || 0));

/**
 * `<glarea>` — an OpenGL surface in the layout.
 *
 * ```jsx
 * <glarea flexGrow={1} clearColor="#0b1021" frameLoop="always"
 *         onDraw={(gl, { width, height }) => { ... }} />
 * ```
 *
 * Props: layout props as usual, plus
 * - `onDraw(gl, { width, height, node })` — draw a frame. The viewport and
 *   the clear are already done; `SwapBuffers` follows.
 * - `onCreated(gl, { width, height, node })` — once, when the context is
 *   current: one-time GL state (`Enable(DEPTH_TEST)`, display lists).
 * - `clearColor` — CSS colour or `[r, g, b, a]` floats (default black).
 * - `frameLoop` — `'demand'` (default: redraw on prop/size/expose changes)
 *   or `'always'` (drive ntk's frame clock continuously).
 * - `glx` — a `chooseGLXConfig` spec, e.g. `{ DEPTH_SIZE: 24 }`.
 *
 * The X child window is stacked above everything drawn in the parent, so 2D
 * content cannot overlap it — put HUD content in a sibling `<popup>`.
 */
export class GlAreaNode extends Node {
  constructor(props, app) {
    super('glarea', props, app);
    this.window = null;
    this.gl = null;
    this.rect = null; // geometry last sent to the X window
    this._realizing = false;
    this._frameScheduled = false;
    this._created = false;
    this.scene = new SceneRenderer(this);
    this.pointer = new ScenePointer(this);
    this._pointerDirty = true;
  }

  get isGlArea() {
    return true;
  }

  _setRoot(root) {
    super._setRoot(root);
    // the owning window may already exist (a <glarea> mounted into a live
    // tree); otherwise WindowNode.realize picks the subtree up
    if (root?.window) this.realize();
  }

  /** Create the GL child window. Async: the visual comes from the server. */
  realize() {
    if (this.window || this.destroyed || this._realizing) return;
    const parent = this.root?.window;
    if (!parent || typeof this.app?.createWindow !== 'function') return;
    this._realizing = true;
    glxConfig(this.app, this.props.glx).then(
      (config) => {
        this._realizing = false;
        if (this.destroyed || this.window) return;
        this._create(config, parent);
      },
      (err) => {
        this._realizing = false;
        this.error = err;
        this.props.onError?.(err);
        if (!this.props.onError) {
          console.warn(`react-x11: <glarea> has no GL surface: ${err.message}`);
        }
      },
    );
  }

  _create(config, parent) {
    const rect = this._geometry();
    const wnd = this.app.createWindow({
      parent,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      visual: config.visual,
      depth: config.depth,
      // GL draws into the window itself: no 2d backing pixmap, and the
      // frame clock is ours to drive
      backingStore: false,
    });
    this.window = wnd;
    this.rect = rect;
    this.config = config;
    wnd._reactX11Node = this;
    this.gl = wnd.getContext('opengl', config);
    wnd.on?.('expose', () => this.requestFrame());
    wnd.map?.();
    this.requestFrame();
  }

  _geometry() {
    return {
      x: Math.round(this.abs.x),
      y: Math.round(this.abs.y),
      width: px(this.abs.width),
      height: px(this.abs.height),
    };
  }

  absolutize(originX, originY) {
    super.absolutize(originX, originY);
    this._syncGeometry();
  }

  _syncGeometry() {
    const wnd = this.window;
    if (!wnd) return;
    const rect = this._geometry();
    const prev = this.rect;
    if (
      prev &&
      prev.x === rect.x &&
      prev.y === rect.y &&
      prev.width === rect.width &&
      prev.height === rect.height
    ) {
      return;
    }
    this.rect = rect;
    if (typeof wnd.setState === 'function') wnd.setState(rect);
    else {
      wnd.move?.(rect.x, rect.y);
      wnd.resize?.(rect.width, rect.height);
    }
    this.requestFrame();
  }

  /** Draw one frame on the child window's next frame tick. */
  requestFrame() {
    if (!this.window || this.destroyed || this._frameScheduled) return;
    this._frameScheduled = true;
    const schedule =
      typeof this.window.requestAnimationFrame === 'function'
        ? (cb) => this.window.requestAnimationFrame(cb)
        : (cb) => setImmediate(cb);
    schedule(() => {
      this._frameScheduled = false;
      this._drawFrame();
    });
  }

  _drawFrame() {
    const gl = this.gl;
    if (!gl || this.destroyed) return;
    const { width, height } = this.rect;
    const info = { width, height, node: this };
    if (!this._created) {
      this._created = true;
      this.props.onCreated?.(gl, info);
    }
    this._syncPointerListeners();
    gl.Viewport(0, 0, width, height);
    const [r, g, b, a] = clearColorOf(this.props);
    gl.ClearColor(r, g, b, a);
    gl.Clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this.scene.render(gl, info);
    this.props.onDraw?.(gl, info);
    gl.SwapBuffers();
    if (this.props.frameLoop === 'always') this.requestFrame();
  }

  applyProps(newProps, oldProps) {
    super.applyProps(newProps, oldProps);
    // onDraw/clearColor are read at frame time, so any update is a new frame
    this.requestFrame();
  }

  setHidden(hidden) {
    super.setHidden(hidden);
    if (hidden) this.window?.unmap?.();
    else this.window?.map?.();
  }

  /**
   * X pointer events are only worth selecting when something in the scene
   * listens for them — the r3f rule that only handler-bearing objects take
   * part in picking, applied one level up, to the wire.
   */
  _syncPointerListeners() {
    if (!this._pointerDirty || !this.window || this.pointer.attached) return;
    this._pointerDirty = false;
    if (!sceneWantsPointer(this.children)) return;
    this.pointer.attach(this.window);
  }

  /** A scene node was added, removed, or gained/lost pointer handlers. */
  _sceneChanged() {
    this._pointerDirty = true;
    this.requestFrame();
  }

  /** scene children (<mesh>, <group>, …) attach to this surface. */
  insertBefore(child, beforeChild) {
    super.insertBefore(child, beforeChild);
    child._setSurface?.(this);
    this._sceneChanged();
  }

  removeChild(child) {
    super.removeChild(child);
    this.invalidateGeometry(child);
    this.pointer.forget(child);
    this._sceneChanged();
  }

  /** A removed geometry's display list is no longer needed server-side. */
  invalidateGeometry(node) {
    if (!node) return;
    if (node.isGeometry) this.scene.forget(this.gl, node);
    for (const child of node.children ?? []) this.invalidateGeometry(child);
  }

  // the child window covers this rect: nothing to paint into the parent's
  // 2d context, and no drawn children are allowed under it
  paint() {}

  destroySubtree() {
    if (this.destroyed) return;
    super.destroySubtree();
    this.scene.dispose(this.gl);
    this.gl?.destroy?.();
    this.gl = null;
    this.window?.destroy?.();
    this.window = null;
  }
}

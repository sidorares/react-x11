// Layer surfaces: the panels, docks, wallpapers and overlays that are not
// windows — wlr-layer-shell, which wlroots compositors and KDE speak and
// GNOME does not.
//
// On X11 a dock is an ordinary window with `_NET_WM_WINDOW_TYPE_DOCK` and a
// strut, placed by the client at screen coordinates. Neither half survives
// here: a client cannot place itself, and there is no screen to have
// coordinates in. What layer-shell offers instead is declarative. A surface
// names a layer (background, bottom, top, overlay), the output edges it is
// anchored to, a size — 0 on an axis anchored at both ends means "stretch" —
// an exclusive zone (the strut: a strip along its edge other windows may not
// cover), and what it wants of the keyboard; the compositor places it and
// says in `configure` how big it ended up. That configure/ack handshake is
// xdg_surface's with a size in it, and the surface underneath is the same
// `wl_surface` a toplevel has, so the frame loop, the swapchain, fractional
// scaling and the seat carry over untouched: a layer window differs from a
// toplevel in its role object and in having no titlebar.
//
// Which windows become layer surfaces is read off the props the tree already
// passes. `windowType` carries the intent — 'dock', 'desktop',
// 'notification', 'splash' — and the measured size gives a dock its
// thickness; an app that wants to name the edge, layer or zone itself passes
// a `layerShell` object (`layerRoleFor` lists the keys). Everything else stays
// an `xdg_toplevel`. The edge a dock lives on is inferred the way an X window
// manager would read the same window: wide and at y 0 is a top panel, wide
// otherwise a bottom one; tall at x 0 is a left dock, tall otherwise a right
// one.

import { requestNullable } from './nullable.js';

/** `zwlr_layer_shell_v1.layer`. */
export const LAYER = { BACKGROUND: 0, BOTTOM: 1, TOP: 2, OVERLAY: 3 };
/** `zwlr_layer_surface_v1.anchor` bits. */
export const ANCHOR = { TOP: 1, BOTTOM: 2, LEFT: 4, RIGHT: 8 };
/** `zwlr_layer_surface_v1.keyboard_interactivity`. */
export const KEYBOARD = { NONE: 0, EXCLUSIVE: 1, ON_DEMAND: 2 };

export const ALL_EDGES =
  ANCHOR.TOP | ANCHOR.BOTTOM | ANCHOR.LEFT | ANCHOR.RIGHT;

const LAYER_NAMES = { background: 0, bottom: 1, top: 2, overlay: 3 };
const EDGE_NAMES = { top: 1, bottom: 2, left: 4, right: 8 };
const KEYBOARD_NAMES = { none: 0, exclusive: 1, 'on-demand': 2, on_demand: 2 };

/**
 * The window types that are layer surfaces, and what each defaults to. A
 * `layerShell` object on the window overrides any of these keys.
 */
const TYPE_DEFAULTS = {
  dock: (attributes, size) => ({
    layer: 'top',
    anchor: dockEdge(attributes, size),
    exclusiveZone: 'auto',
    keyboardInteractivity: 'none',
  }),
  desktop: () => ({
    layer: 'background',
    anchor: 'all',
    exclusiveZone: -1,
    keyboardInteractivity: 'none',
  }),
  notification: () => ({
    layer: 'top',
    anchor: ['top', 'right'],
    margin: 12,
    exclusiveZone: 0,
    keyboardInteractivity: 'none',
  }),
  splash: () => ({
    layer: 'overlay',
    anchor: 'none',
    exclusiveZone: 0,
    keyboardInteractivity: 'none',
  }),
};

/** A `layerShell` object with no window type behind it: a floating overlay. */
const PLAIN_DEFAULTS = {
  layer: 'top',
  anchor: 'none',
  exclusiveZone: 0,
  keyboardInteractivity: 'none',
};

/** The first of a `windowType` array, or the string itself. */
export function primaryWindowType(windowType) {
  return Array.isArray(windowType) ? windowType[0] : windowType;
}

function dockEdge(attributes, { width, height }) {
  if (width >= height) return attributes.y === 0 ? 'top' : 'bottom';
  return attributes.x === 0 ? 'left' : 'right';
}

/**
 * The layer role a window's attributes ask for, or null for an ordinary
 * toplevel.
 *
 * `attributes` are what `WindowNode.realize()` built: device pixels of
 * content, so `scale` is needed to speak the compositor's logical ones. The
 * `layerShell` attribute takes:
 *
 *   layer                 'background' | 'bottom' | 'top' | 'overlay'
 *   anchor                an edge name, an array of them, 'all' or 'none'
 *   exclusiveZone         a number, 'auto' (the window's thickness), or -1
 *   margin                a number, or { top, right, bottom, left }
 *   keyboardInteractivity 'none' | 'on-demand' | 'exclusive'
 *   namespace             what the compositor's rules match the surface by
 *   output                a `wl_output` proxy; omitted, the compositor picks
 *
 * `layerShell: false` keeps a window with a dock type an ordinary toplevel.
 *
 * @returns {null | { layer:number, anchor:number, exclusiveZone:number,
 *   margin:{top:number,right:number,bottom:number,left:number},
 *   keyboardInteractivity:number, namespace:string, output:object|null }}
 */
export function layerRoleFor(attributes = {}, { scale = 1 } = {}) {
  const explicit = attributes.layerShell;
  if (explicit === false) return null;
  const type = primaryWindowType(attributes.windowType);
  const typed = Object.hasOwn(TYPE_DEFAULTS, type);
  if (!explicit && !typed) return null;
  const size = {
    width: (attributes.width ?? 0) / scale,
    height: (attributes.height ?? 0) / scale,
  };
  const defaults = typed
    ? TYPE_DEFAULTS[type](attributes, size)
    : PLAIN_DEFAULTS;
  const spec = {
    ...defaults,
    ...(explicit && typeof explicit === 'object' ? explicit : {}),
  };
  return {
    layer: layerValue(spec.layer),
    anchor: anchorValue(spec.anchor),
    // 'auto' stays symbolic: the zone is the thickness at whatever size the
    // surface ends up, and a resize moves it (`LayerRole.resize`).
    exclusiveZone:
      spec.exclusiveZone === 'auto' ? 'auto' : (spec.exclusiveZone ?? 0) | 0,
    margin: marginValue(spec.margin),
    keyboardInteractivity: keyboardValue(spec.keyboardInteractivity),
    namespace: String(spec.namespace ?? `react-x11-${typed ? type : 'layer'}`),
    output: spec.output ?? null,
  };
}

// ---- value spellings -------------------------------------------------------

export function layerValue(v) {
  if (typeof v === 'number') return v;
  const n = LAYER_NAMES[v];
  if (n === undefined) {
    throw new Error(
      `react-x11 (wayland): unknown layer ${JSON.stringify(v)} — expected ${Object.keys(LAYER_NAMES).join(', ')}`,
    );
  }
  return n;
}

export function anchorValue(v) {
  if (typeof v === 'number') return v;
  if (v == null || v === 'none') return 0;
  if (v === 'all') return ALL_EDGES;
  const edges = Array.isArray(v) ? v : [v];
  let bits = 0;
  for (const e of edges) {
    const bit = EDGE_NAMES[e];
    if (bit === undefined) {
      throw new Error(
        `react-x11 (wayland): unknown anchor edge ${JSON.stringify(e)} — expected top, bottom, left, right, 'all' or 'none'`,
      );
    }
    bits |= bit;
  }
  return bits;
}

export function keyboardValue(v) {
  if (typeof v === 'number') return v;
  if (v == null) return KEYBOARD.NONE;
  const n = KEYBOARD_NAMES[v];
  if (n === undefined) {
    throw new Error(
      `react-x11 (wayland): unknown keyboardInteractivity ${JSON.stringify(v)} — expected none, on-demand or exclusive`,
    );
  }
  return n;
}

export function marginValue(v) {
  if (typeof v === 'number') return { top: v, right: v, bottom: v, left: v };
  return {
    top: (v?.top ?? 0) | 0,
    right: (v?.right ?? 0) | 0,
    bottom: (v?.bottom ?? 0) | 0,
    left: (v?.left ?? 0) | 0,
  };
}

/**
 * The strut a surface of this size casts from the edge it is anchored to:
 * its thickness across the one axis it is anchored on one side of. A surface
 * anchored to a corner, or to no edge, reserves nothing.
 */
export function exclusiveZoneFor(anchor, width, height) {
  const vertical =
    Boolean(anchor & ANCHOR.TOP) !== Boolean(anchor & ANCHOR.BOTTOM);
  const horizontal =
    Boolean(anchor & ANCHOR.LEFT) !== Boolean(anchor & ANCHOR.RIGHT);
  if (vertical && !horizontal) return Math.round(height);
  if (horizontal && !vertical) return Math.round(width);
  return 0;
}

// ---- the role --------------------------------------------------------------

/**
 * What a layer window knows that a toplevel does not, hung on the window as
 * `wl.layer`. `stretchX`/`stretchY` are the axes the compositor sizes: a
 * `resize()` on one of those is a request the configure will overrule.
 */
export class LayerRole {
  constructor(
    win,
    proxy,
    { layer, anchor, exclusiveZone, autoZone = false, namespace },
  ) {
    this.window = win;
    /** the `zwlr_layer_surface_v1` proxy */
    this.proxy = proxy;
    this.layer = layer;
    this.anchor = anchor;
    this.exclusiveZone = exclusiveZone;
    /** the zone is the surface's thickness, and follows its size */
    this.autoZone = autoZone;
    this.namespace = namespace;
    this.stretchX =
      Boolean(anchor & ANCHOR.LEFT) && Boolean(anchor & ANCHOR.RIGHT);
    this.stretchY =
      Boolean(anchor & ANCHOR.TOP) && Boolean(anchor & ANCHOR.BOTTOM);
  }

  /** Ask for a size, in logical pixels; a stretched axis is left to the compositor. */
  setSize(width, height) {
    this.proxy.$.set_size(
      this.stretchX ? 0 : Math.max(1, Math.round(width)),
      this.stretchY ? 0 : Math.max(1, Math.round(height)),
    );
  }

  setExclusiveZone(zone) {
    this.exclusiveZone = zone | 0;
    this.proxy.$.set_exclusive_zone(zone | 0);
  }

  /** A new size, and the strut that follows it when the strut was measured. */
  resize(width, height) {
    this.setSize(width, height);
    if (this.autoZone) {
      this.setExclusiveZone(exclusiveZoneFor(this.anchor, width, height));
    }
  }

  /** Move to another layer (protocol version 2 and up). */
  setLayer(layer) {
    if (this.proxy.version < 2) return false;
    this.layer = layerValue(layer);
    this.proxy.$.set_layer(this.layer);
    return true;
  }
}

/**
 * A layer surface, built without waiting for anything — the body of
 * `WaylandWindow.createLayerSync`, which passes its class in so this file
 * need not import the one that imports it.
 *
 * As with a toplevel the window is not paintable until the first configure
 * has been acked; `whenConfigured` says when. The compositor may hand back a
 * different size than asked, and will on a stretched axis.
 */
export function createLayerSurface(
  WaylandWindow,
  {
    conn,
    compositor,
    layerShell,
    width,
    height,
    layer = LAYER.TOP,
    anchor = 0,
    exclusiveZone = 0,
    margin = 0,
    keyboardInteractivity = KEYBOARD.NONE,
    namespace = 'react-x11',
    output = null,
  },
) {
  if (!layerShell) {
    throw new Error(
      'react-x11 (wayland): this compositor does not advertise zwlr_layer_shell_v1, so there are no layer surfaces here',
    );
  }
  const layerId = layerValue(layer);
  const anchorBits = anchorValue(anchor);
  const m = marginValue(margin);
  const w = Math.max(1, Math.round(width || 1));
  const h = Math.max(1, Math.round(height || 1));
  const zone =
    exclusiveZone === 'auto'
      ? exclusiveZoneFor(anchorBits, w, h)
      : (exclusiveZone ?? 0) | 0;

  const surface = compositor.$.create_surface();
  const proxy = requestNullable(
    layerShell,
    'get_layer_surface',
    surface.id,
    output ?? null,
    layerId,
    String(namespace),
  );
  const win = new WaylandWindow({
    conn,
    surface,
    xdgSurface: null,
    role: proxy,
    kind: 'layer',
    size: { width: w, height: h },
  });
  win.layerSurface = proxy;
  win.layer = new LayerRole(win, proxy, {
    layer: layerId,
    anchor: anchorBits,
    exclusiveZone: zone,
    autoZone: exclusiveZone === 'auto',
    namespace,
  });
  win._wireCommon();

  proxy.on('configure', (serial, cw, ch) => {
    // 0 on an axis means the client keeps its own size there.
    let changed = false;
    if (cw > 0 && cw !== win.width) {
      win.width = cw;
      changed = true;
    }
    if (ch > 0 && ch !== win.height) {
      win.height = ch;
      changed = true;
    }
    if (changed) win.emit('resize', { width: win.width, height: win.height });
    win._onShellConfigure(serial);
  });
  proxy.on('closed', () => win.emit('close'));

  win.layer.setSize(w, h);
  proxy.$.set_anchor(anchorBits);
  proxy.$.set_exclusive_zone(zone);
  proxy.$.set_margin(m.top, m.right, m.bottom, m.left);
  proxy.$.set_keyboard_interactivity(keyboardValue(keyboardInteractivity));
  // the empty commit that asks for the first configure
  surface.$.commit();
  return win;
}

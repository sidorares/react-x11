// The tray on the cocoa backend — `NSStatusItem`, the menu-bar extra, through
// @windowkit/appkit (>= 0.5). The macOS half of the tray react-x11#353 asks
// for; `useTray` (src/trayhooks.js) is the API over it.
//
// An item shows an image (an SF Symbol by name, or PNG bytes drawn as a
// template so they follow the bar's light and dark) and/or a title, with a
// tooltip, and either owns a **menu** — the same `items` vocabulary the
// menu bar and the Dock menu take, through the one spec builder — or
// reports **clicks**, each carrying the item's screen rect, which is the
// anchor for a popup of the app's own.
//
// Two facts about the bridge shape the routing here:
//
// - A click names its item: the event's `statusItem` is the very handle
//   `createStatusItem` returned, so the app keeps a Map keyed on it.
// - A menu activation does **not** — `menu-activate` says `menu: 'status'`
//   and an id, and every item's menu allocates ids from its own snapshot. So
//   each item's allocator starts in a stride of its own (`ID_STRIDE`), the
//   ids of two trays' menus are disjoint by construction, and the app asks
//   each item whether the id is one of its own.
import { IdAllocator, snapshot } from '../dbusmenu.js';
import { menuItemsSpec } from './globalmenu.js';

/** How far apart two items' id ranges start. A menu with a million rows is
 * not a menu; the stride is the size of a number nobody reaches. */
const ID_STRIDE = 1_000_000;
let nextStride = 1;

/** react-x11's tray options as the bridge's item spec, keys it knows only. */
export function statusItemSpec(options = {}) {
  const spec = {};
  if (options.icon !== undefined) {
    // an SF Symbol by name, or the encoded bytes of an image; null clears
    spec.image = options.icon ?? null;
  }
  if (options.title !== undefined) spec.title = options.title ?? '';
  if (options.tooltip !== undefined) spec.tooltip = options.tooltip ?? '';
  if (options.visible !== undefined) spec.visible = options.visible !== false;
  if (options.template !== undefined) spec.imageTemplate = options.template;
  if (options.length !== undefined) spec.length = options.length;
  if (Array.isArray(options.iconSize)) spec.imageSize = options.iconSize;
  return spec;
}

export class CocoaStatusItem {
  constructor(app, options = {}) {
    this.app = app;
    this.alloc = new IdAllocator();
    this.alloc.next = nextStride++ * ID_STRIDE + 1;
    this.nodes = null;
    this.removed = false;
    this.onClick = options.onClick ?? null;
    this.handle = app._native.createStatusItem(statusItemSpec(options));
    this.setMenu(options.menu ?? null);
  }

  /** In-place patch: only the keys present are touched. */
  update(options = {}) {
    if (this.removed) return;
    this.onClick = options.onClick ?? null;
    const spec = statusItemSpec(options);
    if (Object.keys(spec).length) {
      this.app._native.setStatusItem(this.handle, spec);
    }
    this.setMenu(options.menu ?? null);
  }

  /** `items`, or null to go back to reporting clicks. */
  setMenu(items) {
    if (this.removed) return;
    if (!items) {
      this.nodes = null;
      this.app._native.setStatusItemMenu(this.handle, null);
      return;
    }
    this.nodes = snapshot(items, this.alloc);
    this.app._native.setStatusItemMenu(this.handle, menuItemsSpec(this.nodes));
  }

  /** Is this `menu-activate` id one of this item's menu's? */
  owns(id) {
    return Boolean(this.nodes?.has(id));
  }

  activate(id) {
    const item = this.nodes?.get(id)?.item;
    item?.onSelect?.(item);
  }

  /** A `status-item-click` on this item, as the app's event. */
  click(ev) {
    this.onClick?.({
      button: ev.kind,
      x: ev.x,
      y: ev.y,
      width: ev.width,
      height: ev.height,
      clickCount: ev.clickCount ?? 1,
      shift: Boolean(ev.shift),
      control: Boolean(ev.control),
      option: Boolean(ev.option),
      command: Boolean(ev.command),
    });
  }

  remove() {
    if (this.removed) return;
    this.removed = true;
    this.nodes = null;
    this.app._native.removeStatusItem(this.handle);
  }
}

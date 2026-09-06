// The Dock menu on the cocoa backend — `applicationDockMenu:` through
// @windowkit/appkit (>= 0.5), driven from the same `items` vocabulary
// `MenuBar` and the tray take.
//
// The same machinery as the menu bar: dbusmenu.js's `snapshot` gives every
// item a stable id and keeps it across re-renders, and the bridge's menu spec
// is built by the one builder the menu bar uses (`menuItemsSpec`), so the
// three menus an app can put on the desktop are one authoring model. An
// activation comes back as a `menu-activate` event tagged `menu: 'dock'` —
// the bridge's way of saying which tree the id belongs to, since the two
// allocate ids independently — and runs the item's own `onSelect`, the way
// `useGlobalMenu` does.
import { IdAllocator, snapshot } from '../dbusmenu.js';
import { menuItemsSpec } from './globalmenu.js';

export class CocoaDockMenu {
  constructor(app) {
    this.app = app;
    this.alloc = new IdAllocator();
    this.nodes = null;
  }

  /** Install `items`, or take the menu down with null. */
  update(items) {
    if (!items) {
      this.nodes = null;
      this.app._native.setDockMenu(null);
      return;
    }
    this.nodes = snapshot(items, this.alloc);
    this.app._native.setDockMenu(menuItemsSpec(this.nodes));
  }

  /** A `menu-activate` tagged `dock` landed on this menu. */
  activate(id) {
    const item = this.nodes?.get(id)?.item;
    item?.onSelect?.(item);
  }
}

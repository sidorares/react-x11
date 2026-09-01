// The macOS menu bar as a global-menu export (docs/macos.md §Menus).
//
// The Linux global menu was built for exactly this moment: the item
// vocabulary is data, and the pure snapshot/IdAllocator machinery in
// dbusmenu.js produces stable ids with no D-Bus in sight. This adapter
// consumes precisely that — same owner shape as GlobalMenuExport
// (start/stop/update/onChange), so `useGlobalMenu` swaps the transport and
// nothing above it can tell. Where the D-Bus export must wait for a
// registrar to answer, the menu bar is a platform constant: `onChange(true)`
// fires as soon as the menu is installed, and `MenuBar`'s drawn fallback
// never renders here.
//
// Activation comes back as a backend event carrying the item's id —
// AppKit's menu tracking is a modal loop, and those already deliver into JS
// on this backend (live resize does) — routed by the app to the active
// export, which runs the item's own onSelect: the same contract the
// registrar path has.
import { IdAllocator, ROOT_ID, snapshot } from '../dbusmenu.js';

// The synthesized app menu's Quit item. Negative on purpose: IdAllocator
// only counts up from ROOT_ID, so no real item can collide with it.
const QUIT_ID = -2;

// NSEventModifierFlags
const FLAG_SHIFT = 1 << 17;
const FLAG_CONTROL = 1 << 18;
const FLAG_OPTION = 1 << 19;
const FLAG_COMMAND = 1 << 20;

/**
 * One dbusmenu chord — `[['Control', 'z']]` — as NSMenu key equivalents.
 * `Control` maps to Command deliberately: a cross-platform app writes its
 * shortcuts in the primary modifier, and on macOS the primary modifier is
 * ⌘ — a literal mapping would put every accelerator on a modifier no Mac
 * user presses. Multi-chord sequences and non-character keys have no
 * NSMenu spelling and are dropped (the shortcut still works — the app's
 * own key handling is untouched; only the menu's hint goes unshown).
 */
function keyEquivalent(shortcut) {
  const chord = Array.isArray(shortcut) ? shortcut[0] : null;
  if (!Array.isArray(chord) || shortcut.length !== 1) return null;
  let modifiers = 0;
  let key = null;
  for (const part of chord) {
    if (part === 'Control' || part === 'Super') modifiers |= FLAG_COMMAND;
    else if (part === 'Shift') modifiers |= FLAG_SHIFT;
    else if (part === 'Alt') modifiers |= FLAG_OPTION;
    else key = part;
  }
  if (typeof key !== 'string' || [...key].length !== 1) return null;
  return { key: key.toLowerCase(), modifiers: modifiers || FLAG_COMMAND };
}

export class CocoaGlobalMenuExport {
  constructor(app, { getMenus, onSelect, onAboutToShow, target, onChange }) {
    this.app = app;
    this.getMenus = getMenus;
    this.onSelect = onSelect;
    this.onAboutToShow = onAboutToShow;
    this.target = target;
    this.onChange = onChange;
    this.alloc = new IdAllocator();
    this.nodes = null;
    this.exported = false;
  }

  async start() {
    this.app._registerGlobalMenu(this);
    this.update(this.getMenus?.() ?? []);
    this.exported = true;
    this.onChange?.(true);
  }

  async stop() {
    this.exported = false;
    this.app._unregisterGlobalMenu(this);
    this.onChange?.(false);
  }

  update(menus) {
    this.nodes = snapshot(menus ?? [], this.alloc);
    if (this.app._activeGlobalMenu === this) this._install();
  }

  _install() {
    this.app._native.setMainMenu(this._spec());
  }

  /**
   * The snapshot as the bridge's menu spec. The app menu is synthesized in
   * front — macOS requires the first menu and shows the process name on it
   * regardless of title — carrying Quit, which routes back through
   * `activate` like every real item.
   */
  _spec() {
    const itemsOf = (ids) =>
      ids.map((id) => {
        const node = this.nodes.get(id);
        const props = node.props;
        const out = { id };
        if (props.type === 'separator') {
          out.separator = true;
          if (props.visible === false) out.hidden = true;
          return out;
        }
        out.title = String(props.label ?? '');
        if (props.enabled === false) out.enabled = false;
        if (props.visible === false) out.hidden = true;
        if (props['toggle-state'] === 1) out.checked = true;
        // the serialisable icon pair (menuitem.js): the name is read in
        // the platform's icon theme — SF Symbols here, freedesktop on a
        // Linux panel — and the bytes are the literal-pixel fallback
        if (props['icon-name']) out.iconName = props['icon-name'];
        if (props['icon-data']) out.iconData = props['icon-data'];
        const key = keyEquivalent(props.shortcut);
        if (key) {
          out.key = key.key;
          out.modifiers = key.modifiers;
        }
        if (node.childIds.length) out.items = itemsOf(node.childIds);
        return out;
      });
    const root = this.nodes.get(ROOT_ID);
    const menus = itemsOf(root.childIds).map((menu) => ({
      title: menu.title ?? '',
      items: menu.items ?? [],
    }));
    return [
      {
        title: 'App',
        items: [{ id: QUIT_ID, title: 'Quit', key: 'q' }],
      },
      ...menus,
    ];
  }

  /** A backend menu-activate event landed on this export. */
  activate(id) {
    if (id === QUIT_ID) {
      // the same route the close button takes: the app decides what
      // closing means, exactly as it would for the red light
      const wnd = this.target?.window ?? [...this.app._windows.values()][0];
      wnd?.emit('close', { preventDefault() {} });
      return;
    }
    const item = this.nodes?.get(id)?.item;
    if (item) this.onSelect?.(item);
  }
}

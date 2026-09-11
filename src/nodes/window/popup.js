// <popup>: a top-level window of its own for menus, tooltips and dropdowns —
// override-redirect unless it asks otherwise, holding a pointer grab while it
// is up if it asks for one.

import { WindowNode } from './window.js';

/**
 * <popup>: an override-redirect top-level window (needs ntk >= 3.1.0, which
 * forwards the attribute — sidorares/ntk#55). The window manager ignores it:
 * no decorations, no focus stealing — menus, tooltips, dropdowns. `x`/`y`
 * are screen coordinates (anchor with ev.nativeEvent.rootx/rooty or a ref's
 * abs rect + owner window position). It may appear anywhere in the JSX tree
 * but is always its own paint/event root, realized against the screen root
 * in commitMount.
 */
export class PopupNode extends WindowNode {
  /**
   * `grab`: hold a pointer grab while this popup is up. That is how menus
   * work on X — without it a press that lands anywhere else (another app,
   * the root, or this app's own window *frame*, which belongs to the window
   * manager) never reaches us, so the menu stays open behind whatever the
   * user clicked. With the grab, that press arrives here instead, outside
   * our bounds, and `onDismiss` fires. Needs ntk >= 3.7.0; without it the
   * popup simply behaves as before.
   *
   * The grab rides the map, not `realize()`: X refuses a grab on an
   * unviewable window (`GrabNotViewable`) and silently drops one whose
   * window unmaps, so a popup born `hidden` — or one whose anchor is off
   * screen — takes the grab when it actually reaches the screen. Grabbing
   * from realize looked equivalent until `hidden` existed, and would have
   * left a revealed menu holding no grab: open forever behind the first
   * outside click, with nothing saying why.
   */
  _mapNow() {
    if (!super._mapNow()) return false;
    if (this.props.grab) this.window.grabPointer?.({}, () => {});
    return true;
  }

  destroySubtree() {
    if (this.props.grab) this.window?.ungrabPointer?.();
    super.destroySubtree();
  }

  constructor(app, attributes, props) {
    // Override-redirect is the default and is what keeps the window manager
    // from repositioning or decorating a menu — but it is now a default
    // rather than a fact, because it is the one bit standing between
    // `<popup>` and a real, WM-managed dialog: `overrideRedirect={false}`
    // gives a decorated, movable window the WM will stack above its owner
    // and iconify with it. Menus, tooltips and `Select` keep the default.
    //
    // The EWMH type hint is additive — the spec asks for it on
    // override-redirect windows too, so compositing managers can give menus
    // and tooltips consistent shadows/animations. `windowType` overrides the
    // default (e.g. "tooltip", "dropdown_menu"); `popup_menu` is the
    // least-wrong answer for a popup that declares nothing, and the widgets
    // that know better say so themselves — `Select`'s sheet is a
    // `dropdown_menu`, a `Tooltip` a `tooltip` (issue #298).
    super(
      app,
      {
        ...attributes,
        overrideRedirect: attributes.overrideRedirect ?? true,
        windowType: attributes.windowType ?? 'popup_menu',
      },
      props,
    );
    this.isPopup = true;
  }
}

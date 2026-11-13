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
   *
   * `grabKeyboard` is the keyboard's half, taken and dropped with the map
   * the same way: keys come to this popup while it is up, whatever holds
   * the focus — what a popover a tray click opened needs, since a menu-bar
   * app has no window of its own for the keys to reach. On Cocoa it is a
   * property of the window rather than a grab, and was decided when the
   * window was made (src/cocoa/window.js); on Wayland a grabbing popup has
   * the keyboard already.
   */
  _mapNow() {
    if (!super._mapNow()) return false;
    if (this.props.grab) this.window.grabPointer?.({}, () => {});
    if (this.props.grabKeyboard) this.window.grabKeyboard?.({}, () => {});
    this._watchFocusAway();
    return true;
  }

  destroySubtree() {
    if (this.props.grab) this.window?.ungrabPointer?.();
    if (this.props.grabKeyboard) this.window?.ungrabKeyboard?.();
    this._offFocusAway?.();
    this._offFocusAway = null;
    super.destroySubtree();
  }

  /**
   * A grabbing popup is dismissed when the user goes to another application
   * — `onDismiss`, with `reason: 'focus'` — and not only when a press lands
   * outside it.
   *
   * The press does not cover it. On Cocoa the grab is ours rather than the
   * window server's: it redirects a press between windows of this app
   * (`CocoaApp._grabTarget`), and a click in another application, or ⌘-Tab,
   * sends us nothing at all. The popup is an `NSPanel` at the pop-up-menu
   * level that does not hide when the app deactivates, so a menu left up
   * stayed drawn over whatever the user switched to, for good. On X the grab
   * catches the click, but not a keyboard switch: alt-tab is the window
   * manager's passive grab, and the menu stays up over the next window. What
   * every backend does report is the window losing the keyboard, so that is
   * the signal, here, once — which also makes a menu built straight on
   * `<popup grab onDismiss>` behave as `Select` and `Menu` do, rather than
   * leaving each app to find out it has to listen to the window too.
   *
   * Whose focus: the top-level window the popup hangs from, whose keyboard
   * it shares — except for a popup that takes the keyboard itself
   * (`grabKeyboard`), which listens to its own window. That one's owner
   * *loses* the keyboard to it as it opens (a key window on Cocoa, a
   * `FocusOut` from the grab on X), and its own window losing it is the user
   * leaving: a tray popover now closes on `onDismiss` alone.
   *
   * Read when it fires rather than when it is set up, so a popup whose
   * `grab` or `onDismiss` changes while it is up is judged as it is now.
   */
  _watchFocusAway() {
    if (this._offFocusAway) return;
    const offs = [
      this.onWindowFocusChange((focused) => {
        if (!focused) this._focusLeft(this);
      }),
    ];
    const top = this.events?.topLevelManager?.node;
    if (top && top !== this && typeof top.onWindowFocusChange === 'function') {
      offs.push(
        top.onWindowFocusChange((focused) => {
          if (!focused) this._focusLeft(top);
        }),
      );
    }
    this._offFocusAway = () => {
      for (const off of offs) off();
    };
  }

  _focusLeft(from) {
    if (this.destroyed || !this.props.grab) return;
    if (typeof this.props.onDismiss !== 'function') return;
    const top = this.events?.topLevelManager?.node;
    // with an owner, one of the two windows is this popup's, and which one
    // is decided by whether it holds the keyboard itself
    if (top && top !== this) {
      const own = from === this;
      if (own !== Boolean(this.props.grabKeyboard)) return;
    }
    this.events.dismiss('focus', { buttons: 0, time: Date.now() });
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

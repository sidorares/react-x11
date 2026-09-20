// `<popup grab>` on Windows: what closes a menu when you click beside it.
//
// X11 gives a menu a pointer grab, so the press that lands anywhere else is
// delivered *to the menu*, outside its bounds, and the event manager answers
// it with `onDismiss`. Windows has no such grab — `SetCapture` sends a window
// the mouse only while a button is already down, so a press that starts
// elsewhere never arrives — and the backend used to accept `grabPointer` and
// do nothing. A `<Select>` dropdown or a `<Menu>` stayed open behind whatever
// the user clicked, with nothing saying why.
//
// What the grab is *for* is observable without it, and that is what is tested
// here: a press delivered to another of our windows, and the application
// losing activation. Both end in the same made-up outside press the Wayland
// backend sends for `xdg_popup.popup_done`, so all three backends answer a
// dismissal through one path.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Win32App } from '../../src/win32/app.js';
import { Win32Window } from '../../src/win32/window.js';
import { createFakeBridge } from './fake-bridge.js';

/** An app on the fake bridge, with `n` windows and a press recorder. */
function setup(count = 2) {
  const bridge = createFakeBridge();
  const app = new Win32App(bridge, {});
  const windows = [];
  for (let i = 0; i < count; i++) {
    const wnd = new Win32Window(app, {
      width: 200,
      height: 120,
      title: `w${i}`,
    });
    // What the tree would hear. `_dismissFromOutside` emits a press outside
    // the window's own bounds, which is what `onDismiss` is made of.
    wnd.presses = [];
    wnd.on('mousedown', (ev) => wnd.presses.push(ev));
    windows.push(wnd);
  }
  return { bridge, app, windows };
}

/** The bridge event `_route` takes for a press in a window. */
const press = (id) => ({ type: 'mousedown', id, a: 10, b: 12, c: 1, d: 0 });
const blur = (id) => ({ type: 'window-blur', id });

/** Did this window hear a press from outside itself? */
const dismissed = (wnd) => wnd.presses.some((ev) => ev.dismissed === true);

describe('win32 <popup grab>: a press somewhere else', () => {
  it('closes a menu when the press lands in another window', () => {
    const { app, windows } = setup();
    const [owner, menu] = windows;
    menu.grabPointer({}, () => {});

    app._route(press(owner.id));

    assert.ok(dismissed(menu), 'the menu never heard the press beside it');
    const ev = menu.presses.find((e) => e.dismissed);
    assert.ok(
      ev.x < 0 && ev.y < 0,
      'the press has to be outside the popup, or it reads as a click in it',
    );
  });

  it('does not close a menu the press landed in', () => {
    const { app, windows } = setup();
    const [, menu] = windows;
    menu.grabPointer({}, () => {});

    app._route(press(menu.id));

    assert.equal(dismissed(menu), false, 'clicking the menu closed the menu');
    assert.equal(menu.presses.length, 1, 'and the real press still arrived');
  });

  it('closes it when the application loses activation', () => {
    const { app, windows } = setup();
    const [owner, menu] = windows;
    menu.grabPointer({}, () => {});

    // The press went to another application or to the desktop: no window of
    // ours sees it, and what we get instead is the owner going inactive.
    app._route(blur(owner.id));

    assert.ok(dismissed(menu), 'a click in another app left the menu open');
  });

  it('leaves a popup that never asked for a grab alone', () => {
    const { app, windows } = setup();
    const [owner, tooltip] = windows;
    // No `grabPointer`: a tooltip follows its anchor and is not dismissible.
    app._route(press(owner.id));
    app._route(blur(owner.id));
    assert.equal(dismissed(tooltip), false);
  });

  it('stops once the grab is dropped', () => {
    const { app, windows } = setup();
    const [owner, menu] = windows;
    menu.grabPointer({}, () => {});
    menu.ungrabPointer();

    app._route(press(owner.id));

    assert.equal(dismissed(menu), false, 'a closed menu was still listening');
  });

  it('a submenu closes on a press in its parent menu, which stays open', () => {
    const { app, windows } = setup(3);
    const [, menu, submenu] = windows;
    menu.grabPointer({}, () => {});
    submenu.grabPointer({}, () => {});

    app._route(press(menu.id));

    assert.ok(dismissed(submenu), 'the submenu outlived a click in its parent');
    assert.equal(
      dismissed(menu),
      false,
      'and the parent closed with it — an X11 grab hands the press to the ' +
        'innermost holder, and this has to match',
    );
  });

  it('a dismissal that unmounts the popup does not disturb the walk', () => {
    const { app, windows } = setup(3);
    const [owner, first, second] = windows;
    first.grabPointer({}, () => {});
    second.grabPointer({}, () => {});
    // What `onDismiss` really does: unmount, which runs `ungrabPointer` and
    // deletes from the very set the loop is reading.
    first.on('mousedown', (ev) => {
      if (ev.dismissed) first.ungrabPointer();
    });

    app._route(press(owner.id));

    assert.ok(dismissed(first));
    assert.ok(dismissed(second), 'the second menu was skipped mid-walk');
  });

  it('reports the grab as taken, because the behaviour behind it is there', () => {
    const { windows } = setup();
    const [, menu] = windows;
    let answered = null;
    menu.grabPointer({}, (err, status) => {
      answered = { err, status };
    });
    // It said this before anything watched, which is the worst of both: a
    // caller that checked was told it held a grab it did not have.
    assert.deepEqual(answered, { err: null, status: 0 });
  });
});

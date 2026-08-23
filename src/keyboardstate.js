// Caps Lock, Num Lock, and which keyboard layout is live.
//
// The one thing an application cannot work out for itself. A key event
// carries the modifier state at the moment it was pressed, so an app can see
// that Caps Lock was on for *a key it received* — which is exactly no help in
// the case that matters, a password field that wants to warn before the first
// character is typed and while the field is merely focused.
//
// XKB answers both halves directly: `GetState` for the state now,
// `StateNotify` for every change after that, including the ones that happen
// while another window has the keyboard. There is no polling and no timer.
//
// ## Which bit is which lock
//
// Caps Lock is `LockMask`, fixed by the core protocol. **Num Lock is not
// fixed by anything** — it is wherever the modifier map puts it, and that is
// `Mod2` on every Linux and BSD desktop, on XQuartz, and in every toolkit
// that hardcodes it (GTK reads the modmap; Qt hardcodes Mod2). Reading the
// modifier map to be sure costs a round trip and a keysym search to arrive at
// Mod2 in every real case, so this takes the convention — the same one
// `MOD.Mod2` in `keysyms.js` already documents for Alt and Super.
//
// ## Where the layout names come from
//
// `GetState().group` is an *index*, 0 to 3, and says nothing about what is in
// the group. The names live in `_XKB_RULES_NAMES` on the root window — the
// property `setxkbmap` writes and `setxkbmap -query` reads back — as
// NUL-separated rules, model, layouts, variants and options. So `us,ru` plus
// group 1 is `'ru'`.
//
// XKB's own `GetNames(GroupNames)` is the other route and is not used here:
// it answers atoms that have to be interned back one round trip each, and
// what it returns is a description like `English (US)` where an indicator in
// a status bar wants `us`.

import { requireExtension } from './extensions.js';

const sessions = new WeakMap();

/** `1 << xkbType` for the two events this needs. */
const NEW_KEYBOARD_NOTIFY = 1 << 0;
const STATE_NOTIFY = 1 << 2;

const XKB_USE_CORE_KBD = 0x100;
const LOCK_MASK = 2; // MOD.Lock — Caps Lock, per the core protocol
const MOD2_MASK = 16; // MOD.Mod2 — Num Lock, per universal convention
const RULES_PROPERTY = '_XKB_RULES_NAMES';

/**
 * What is known before XKB has answered, and what stays true on a display
 * without the extension.
 *
 * Every field is the "off" answer rather than a null, because every caller of
 * this is drawing something: a Caps Lock warning that renders `null` as truthy
 * is worse than one that is briefly absent, and it is absent for one frame.
 * `layouts` being empty is what distinguishes "not known" from "no lock on".
 */
const UNKNOWN = Object.freeze({
  capsLock: false,
  numLock: false,
  group: 0,
  layout: null,
  layouts: Object.freeze([]),
});

class KeyboardSession {
  constructor(app) {
    this.app = app;
    this.snapshot = UNKNOWN;
    this.listeners = new Set();
    this.armed = false;
    this.stopped = false;
    this._handler = null;
  }

  publish(values) {
    const next = { ...this.snapshot, ...values };
    // `layout` is derived in one place so it cannot disagree with the group
    // and the list it comes from — a group index past the end of a
    // just-reconfigured list is null rather than undefined.
    next.layout = next.layouts[next.group] ?? null;
    const prev = this.snapshot;
    if (
      next.capsLock === prev.capsLock &&
      next.numLock === prev.numLock &&
      next.group === prev.group &&
      next.layout === prev.layout &&
      // by value: `readLayouts` builds a fresh array every time it runs, and
      // it runs again on every keymap replacement, most of which change
      // nothing about the list
      next.layouts.length === prev.layouts.length &&
      next.layouts.every((l, i) => l === prev.layouts[i])
    ) {
      return;
    }
    this.snapshot = Object.freeze(next);
    for (const fn of [...this.listeners]) {
      try {
        fn();
      } catch {
        // one subscriber throwing must not take the others with it, nor the
        // X event loop this runs on
      }
    }
  }

  stop() {
    this.stopped = true;
    if (this._handler && this.app?.X?.off) {
      try {
        this.app.X.off('event', this._handler);
      } catch {
        // an ntk old enough to hand back a client with no `off`
      }
    }
    this._handler = null;
    this.listeners.clear();
  }
}

/**
 * `_XKB_RULES_NAMES` → the configured layout codes.
 *
 * Five NUL-terminated strings — rules, model, layouts, variants, options —
 * of which the third is `us,ru`. Pure, and exported for the test: the
 * in-process X server has no XKB, so this is the part of the path that can
 * be pinned without one.
 *
 * A trailing NUL leaves an empty final field, and a layout list can
 * legitimately have an empty entry (`us,,ru` from a hand-edited config), so
 * the split keeps position and drops only what is empty at the ends.
 */
export function layoutsFromRules(data) {
  if (!data?.length) return [];
  const fields = data.toString('latin1').split('\0');
  const layouts = fields[2];
  if (!layouts) return [];
  const list = layouts.split(',').map((s) => s.trim());
  while (list.length && !list[list.length - 1]) list.pop();
  // `empty` is a real xkeyboard-config layout, and what it is defined as is a
  // layout with no symbols in it — which is exactly what XQuartz writes here,
  // because it synthesizes its keymap from macOS and has no XKB layout to
  // name. Reporting it would put "EMPTY" in a status-bar indicator; an empty
  // list is what "this display cannot say" already means everywhere else here.
  return list.every((name) => name === 'empty') ? [] : list;
}

/** Caps and Num out of a locked-modifier mask. */
export function locksFromMods(lockedMods) {
  return {
    capsLock: Boolean(lockedMods & LOCK_MASK),
    numLock: Boolean(lockedMods & MOD2_MASK),
  };
}

async function arm(session) {
  if (session.armed) return;
  session.armed = true;
  const app = session.app;
  const xkb = await requireExtension(app, 'xkb');
  if (!xkb || session.stopped) return;

  // Subscribe before reading. A lock toggled between the two would otherwise
  // be lost for the life of the connection — the same ordering rule the
  // appearance ladder and the clipboard watch both follow.
  const handler = (ev) => {
    if (session.stopped || ev.type !== xkb.firstEvent) return;
    if (ev.xkbType === xkb.events.StateNotify) {
      session.publish({ ...locksFromMods(ev.lockedMods), group: ev.group });
      return;
    }
    // NewKeyboardNotify: the keymap itself was replaced, which is what
    // `setxkbmap` does when the *set* of layouts changes rather than which
    // one is active. Rare, and cheap to answer — one property read.
    if (ev.xkbType === 0) readLayouts(session);
  };
  session._handler = handler;
  app.X.on('event', handler);

  try {
    xkb.SelectEvents(
      XKB_USE_CORE_KBD,
      STATE_NOTIFY | NEW_KEYBOARD_NOTIFY,
      0,
      STATE_NOTIFY | NEW_KEYBOARD_NOTIFY,
      0,
      0,
    );
  } catch {
    return;
  }

  readLayouts(session);

  const state = await new Promise((resolve) => {
    try {
      xkb.GetState(XKB_USE_CORE_KBD, (err, value) =>
        resolve(err ? null : value),
      );
    } catch {
      resolve(null);
    }
  });
  if (state && !session.stopped) {
    session.publish({ ...locksFromMods(state.lockedMods), group: state.group });
  }
}

async function readLayouts(session) {
  const X = session.app.X;
  const root = X.display?.screen?.[0]?.root;
  if (root == null) return;
  try {
    const atom = await new Promise((resolve, reject) =>
      X.InternAtom(false, RULES_PROPERTY, (err, value) =>
        err ? reject(err) : resolve(value),
      ),
    );
    const prop = await new Promise((resolve) =>
      X.GetProperty(0, root, atom, 0, 0, 0x1fffffff, (err, value) =>
        resolve(err ? null : value),
      ),
    );
    if (session.stopped) return;
    const layouts = layoutsFromRules(prop?.data);
    if (layouts.length) session.publish({ layouts: Object.freeze(layouts) });
  } catch {
    // no rules property: a server configured by other means, or XQuartz,
    // where the group index is all there is. `layouts` stays empty and
    // `layout` stays null, which is what those say.
  }
}

/** What is known right now. Not public — `useKeyboardState()` is. */
export function keyboardStateSnapshot(app) {
  return sessions.get(app)?.snapshot ?? UNKNOWN;
}

/** Subscribe to the lock and layout state changing. */
export function watchKeyboardState(app, onChange) {
  if (!app) return () => {};
  let session = sessions.get(app);
  if (!session) {
    session = new KeyboardSession(app);
    sessions.set(app, session);
  }
  arm(session).catch(() => {
    // an extension that is not there is not an error
  });
  session.listeners.add(onChange);
  return () => session.listeners.delete(onChange);
}

/** Tear down with the root that started it. */
export function endKeyboardState(app) {
  const session = sessions.get(app);
  if (!session) return;
  session.stop();
  sessions.delete(app);
}

/**
 * Test seam: state the keyboard without a server that has XKB. Marks the
 * session armed, so nothing tries to reach the extension behind the value.
 */
export function setKeyboardStateForTests(app, values) {
  let session = sessions.get(app);
  if (!session) {
    session = new KeyboardSession(app);
    sessions.set(app, session);
  }
  session.armed = true;
  session.publish({
    ...values,
    layouts: Object.freeze(values.layouts ?? UNKNOWN.layouts),
  });
  return session;
}

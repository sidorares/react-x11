// Is there anything to paste? — kept per app, so a menu can answer without
// a round trip.
//
// The honest answer needs the server, and asking for it costs a full
// conversion against whatever foreign client owns the selection — plus a
// two second wait when that client is wedged. A menu cannot pay that while
// it is opening, which is why the built-in edit menu shipped with Paste
// always enabled.
//
// XFixes turns it around: the server says when the selection changes hands,
// and the answer is a boolean already in hand by the time a menu opens. One
// registration per app, armed the first time anything asks.
//
// Deliberately only "is it owned", not "does it hold text". Refining it
// would mean a TARGETS round trip per change, which reintroduces the cost
// this exists to avoid; an owner offering nothing a text field can take is
// rare enough to leave the row enabled and let the paste do nothing.

const states = new WeakMap();

/**
 * Start tracking `app`'s CLIPBOARD, once. Safe to call on every menu open —
 * the second call and the ten thousandth do nothing.
 */
export function armPasteState(app, clipboard) {
  if (!app || !clipboard || states.has(app)) return;
  // A clipboard without these is an older ntk, or a stand-in someone
  // supplied. Tracking is the enhancement, not the feature: skip it and
  // leave the row enabled rather than throwing on the way into a menu.
  if (
    typeof clipboard.watch !== 'function' ||
    typeof clipboard.targets !== 'function'
  ) {
    return;
  }
  // Unknown means "yes": until the server has said otherwise, behave the way
  // this did before there was any tracking at all.
  const state = { owned: true, live: false };
  states.set(app, state);

  clipboard
    .watch('CLIPBOARD', (ev) => {
      state.live = true;
      state.owned = ev.owner !== 0;
    })
    .catch(() => {
      // No XFixes on this server. Nothing to fall back to that is worth the
      // latency, so the row stays enabled — which is where it started.
    });

  // `watch` reports *changes*, so it says nothing about the selection that
  // was already there when we armed. One question, once per app, off the
  // menu's path entirely.
  clipboard
    .targets({ selection: 'CLIPBOARD' })
    .then((offered) => {
      // a change may have overtaken this round trip; it is the fresher answer
      if (!state.live) state.owned = offered.length > 0;
    })
    .catch(() => {});
}

/** Whether a Paste row should be live. True when nothing is known yet. */
export function canPaste(app) {
  return states.get(app)?.owned ?? true;
}

// Whether this process talks to the desktop at all — the `desktop` option on
// `createRoot()`, and the one place that decides what it covers.
//
// ## What is in the group and why
//
// Three things react-x11 turns on for you without being asked, and all three
// reach the session bus:
//
//   `appearance`  the light/dark, accent, contrast and reduced-motion ladder
//                 (src/appearance.js) — the settings portal, then macOS, then
//                 XSETTINGS
//   `a11y`        the AT-SPI bridge, started from `createRoot()`
//                 (src/a11y.js, docs/accessibility.md)
//   `globalMenu`  a `MenuBar` handing its menu to the panel instead of drawing
//                 it (src/globalmenu.js, docs/globalmenu.md)
//
// Each already had an off switch and each of those was an **environment
// variable** — `REACT_X11_A11Y=0`, `NO_AT_BRIDGE=1`,
// `REACT_X11_NO_GLOBAL_MENU=1`, or unsetting `DBUS_SESSION_BUS_ADDRESS` for
// the appearance ladder. That is a seam an app cannot reach for itself: the
// environment is inherited, so a process that sets one before `createRoot()`
// has also set it for every child it spawns, and the D-Bus one turns off the
// portals and the app's own services along with the follower. AGENTS.md asks
// for the off switch to be somewhere the embedder can actually stand.
//
// ## Why the policy is process-wide when the option is per-root
//
// Because so is the thing it describes. There is one desktop, one D-Bus
// identity, and one AT-SPI bridge per process — `startA11y()` says so in its
// name, and appearance.js says so in its header. A per-root flag over
// process-wide state would be a seam that reads as finer than it is.
//
// So **off wins, and off latches.** A root that says `desktop: false` is a
// root with a constraint — an embedder that owns the toplevel, a test, a
// daemon that must not fork — and a second root quietly turning the feature
// back on for it would be the bug. Turning something back *on* is a thing
// this module deliberately cannot do.
//
// The one honest limit: a feature already started stays started. `startA11y()`
// is memoised per process, so a second root's `desktop: false` stops the next
// climb and not the bridge that is already up. Pass it on the first root.

/** @typedef {'appearance'|'a11y'|'globalMenu'} DesktopFeature */

/** @type {DesktopFeature[]} */
const FEATURES = ['appearance', 'a11y', 'globalMenu'];

/** What has been turned off, for the life of the process. */
const off = new Set();

/**
 * Apply a root's `desktop` option. Not public — `createRoot({ desktop })` is
 * the public shape.
 *
 * `undefined` is the default and means every feature stays on; `false` turns
 * all of them off; an object names them one at a time, and a key left out is
 * left alone.
 *
 * @param {boolean | Partial<Record<DesktopFeature, boolean>> | undefined} desktop
 */
export function setDesktopIntegration(desktop) {
  if (desktop === undefined || desktop === true) return;
  if (desktop === false) {
    for (const feature of FEATURES) off.add(feature);
    return;
  }
  if (typeof desktop !== 'object') {
    throw new TypeError(
      'react-x11: createRoot({ desktop }) takes false or an object of ' +
        `${FEATURES.map((f) => `${f}: false`).join(', ')} — got ` +
        `${JSON.stringify(desktop)}.`,
    );
  }
  for (const [feature, on] of Object.entries(desktop)) {
    if (!FEATURES.includes(/** @type {DesktopFeature} */ (feature))) {
      throw new TypeError(
        `react-x11: createRoot({ desktop: { ${feature} } }) — no such ` +
          `desktop integration. Expected ${FEATURES.join(', ')}.`,
      );
    }
    if (on === false) off.add(feature);
  }
}

/**
 * Whether a feature may run. Every one of the three asks this first, ahead of
 * its own environment variable, so `desktop: false` is the outermost answer.
 *
 * @param {DesktopFeature} feature
 */
export function desktopIntegrationEnabled(feature) {
  return !off.has(feature);
}

/** Test seam, not public: forget the latch. */
export function _resetDesktopIntegration() {
  off.clear();
}

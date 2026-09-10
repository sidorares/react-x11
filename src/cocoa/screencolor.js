// One colour off the screen on the cocoa backend — `NSColorSampler` through
// @windowkit/appkit (>= 0.9), the top rung of src/screencolor.js's ladder on
// this backend. `CocoaApp.colorSampler` is this object and its *presence* is
// the capability, the rule `filePanels`, `permissions` and `calendars`
// follow, so the ladder never names a backend.
//
// It is the portal's shape rather than X11's, which is why it goes on *top*
// of the ladder and not under it: the system draws the loupe, out of
// process, so this app needs no Screen Recording grant of its own and the
// user gets the magnifier every other Mac colour picker shows them. There is
// no grab here, no root window read, and nothing for the crosshair rung to
// fall back to — the cocoa `X` is a stub (src/cocoa/app.js), which is why
// this file existing is the difference between an eyedropper button on macOS
// and none.
//
// Two things about the framework shape what is *not* here:
//
// - **Nothing dismisses the sampler from code.** AppKit offers no
//   counterpart to `cancelPanel` — the session ends when the user picks or
//   presses Escape — so there is no abort inside this wrapper the way
//   `CocoaFilePanels.show` has one. A caller's `signal` can only stop *us*
//   waiting; that is the rung's business, and it is spelled out there.
// - **One session, not one per call.** `NSColorSampler` "begins or attaches
//   to an existing color sampling session", so a second sample while a loupe
//   is up joins it and both callers get the same colour. The bridge keeps
//   that promise; nothing here needs the X11 rung's loud refusal, which
//   exists because a second `GrabPointer` silently replaces the first.

export class CocoaColorSampler {
  constructor(native) {
    this._native = native;
  }

  /**
   * Show the system sampler and answer once.
   *
   * Resolves `{ r, g, b }` — sRGB, 0–1 floats, the Screenshot portal's
   * `(ddd)` shape, which is what lets both rungs share one conversion — or
   * **`null`** when the user dismissed the sampler without picking. A
   * cancel is an ordinary outcome, not an error, on every rung of this
   * ladder; a rejection here means a colour that could not be read at all
   * (a pattern colour, which has no sRGB form).
   *
   * The answer arrives on the main thread, so the app has to be pumping —
   * which a mounted react-x11 tree is by definition.
   *
   * @returns {Promise<{ r: number, g: number, b: number } | null>}
   */
  sample() {
    return new Promise((resolve, reject) => {
      try {
        this._native.sampleScreenColor((err, color) =>
          err ? reject(err) : resolve(color ?? null),
        );
      } catch (err) {
        // A bad argument shape is a TypeError out of the bridge, before
        // anything is shown. Rejecting keeps every failure on one channel.
        reject(err);
      }
    });
  }
}

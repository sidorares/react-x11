// Whether this display plays a file or URL itself — `<video src>` — and the
// error a `<video src>` reports where it does not.
//
// `<video>` asks before it opens anything, and `useSupports('mediaPlayback')`
// asks for a component deciding what to render. One function for both, so
// the two cannot disagree (#531's rule, src/embedding.js's shape). A feature
// test on the app, not a question about which backend this is: the answer is
// yes where the app can make a player — the Cocoa app over a bridge with
// AVFoundation's player verbs — and no on X11 and Wayland for good, where no
// display-server player exists and the application decodes into `frames`.
//
// A leaf module on purpose: it imports nothing of ours, so both
// `appcontext.js` and the node layer can use it.

/** Can `app` play a `<video src>` with a platform player? */
export function canPlayMedia(app) {
  return typeof app?.createPlayer === 'function';
}

/**
 * `<video src>` where this backend has no platform player — the error
 * `onError` is handed, so an application can tell it from a file that would
 * not play.
 */
export class NoMediaPlaybackError extends Error {
  constructor() {
    super(
      'react-x11: <video src> needs a platform media player, and this ' +
        'backend has none — so the poster is shown instead. Ask ' +
        "useSupports('mediaPlayback') before rendering one, and give a " +
        'backend without a player frames you decode yourself: <video ' +
        'frames={useVideoFrames(…)}> works everywhere (docs/elements.md#video).',
    );
    this.name = 'NoMediaPlaybackError';
    this.code = 'ENOMEDIAPLAYBACK';
  }
}

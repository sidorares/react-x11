// Whether this display plays a file or URL itself — `<video src>` and
// `<audio src>` — the error either reports where it does not, and the
// player's settings among their props.
//
// The elements ask before they open anything, and
// `useSupports('mediaPlayback')` asks for a component deciding what to
// render. One function for all of them, so they cannot disagree (#531's
// rule, src/embedding.js's shape). A feature
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
 * `<video src>` or `<audio src>` where this backend has no platform player —
 * the error `onError` is handed, so an application can tell it from a file
 * that would not play. `element` names which asked.
 */
export class NoMediaPlaybackError extends Error {
  constructor(element = 'video') {
    super(
      element === 'audio'
        ? 'react-x11: <audio src> needs a platform media player, and this ' +
            'backend has none — so nothing is heard. Ask ' +
            "useSupports('mediaPlayback') before rendering one " +
            '(docs/elements.md#audio).'
        : 'react-x11: <video src> needs a platform media player, and this ' +
            'backend has none — so the poster is shown instead. Ask ' +
            "useSupports('mediaPlayback') before rendering one, and give a " +
            'backend without a player frames you decode yourself: <video ' +
            'frames={useVideoFrames(…)}> works everywhere (docs/elements.md#video).',
    );
    this.name = 'NoMediaPlaybackError';
    this.code = 'ENOMEDIAPLAYBACK';
  }
}

/** The player's settings among a `<video>`'s or an `<audio>`'s props, as
 *  the player takes them. */
export const PLAYER_PROPS = [
  'paused',
  'muted',
  'volume',
  'loop',
  'playbackRate',
];

/** What `app.createPlayer` is handed for `props`: playing from the start
 *  where they say so — a controlled `paused={false}`, or `autoPlay`. */
export function playerOptions(props) {
  return {
    autoPlay:
      props.paused !== undefined
        ? props.paused === false
        : Boolean(props.autoPlay),
    loop: props.loop,
    muted: props.muted,
    volume: props.volume,
    playbackRate: props.playbackRate,
  };
}

/** The settings that changed between two sets of props, as `player.set`
 *  takes them, or null where none did. */
export function changedSettings(props, before) {
  let settings = null;
  for (const name of PLAYER_PROPS) {
    if (props[name] !== before[name]) (settings ??= {})[name] = props[name];
  }
  return settings;
}

// Stand-in for the D-Bus transport, which is node-only by construction: it
// dials a unix socket and reaches for `child_process`, `crypto`, `net` and
// `stream`. `src/bus.js` imports it *dynamically*, inside the first
// acquisition, so nothing in the browser bundle needs it — but esbuild
// follows a dynamic import all the same, and pulling it in fails the build on
// six node builtins that have no browser answer.
//
// Throwing from the module body rather than handing back an inert proxy is
// deliberate: it is exactly what `await import('dbus-native')` does on a Node
// 20 install, where npm skipped the optional dependency. `loadTransport()`
// turns that rejection into a `BusUnavailableError` whose cause says the
// transport is missing, `sessionBus()` answers `null`, and `useSessionBus()`
// reports `'unavailable'`. So the playground is not a special case with a
// stub bolted on — it is a genuine instance of the "there is no bus here"
// configuration docs/dbus.md calls first-class, and a demo that calls the
// hooks renders the same fallback it would over ssh.
throw new Error(
  'react-x11 playground: there is no D-Bus in a browser, so the transport ' +
    'is not bundled. This is the same path a Node 20 install takes — ' +
    'useSessionBus() reports "unavailable" and sessionBus() answers null.',
);

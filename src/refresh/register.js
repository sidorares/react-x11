// react-x11/refresh/register — hot reload with the defaults, for --import:
//
//   node --enable-source-maps --import react-x11/refresh/register main.jsx
//
// The app writes no wiring of its own: the loader injects the runtime into
// every hot module, edits to components apply in place with hook state
// intact, and `onReload` (from react-x11/refresh) is there when a tool wants
// to observe the reloads. What the app does owe is a split: main.jsx is
// never watched — hot-module-replacement watches a module when another
// imports it — so the components it mounts live in modules it imports, and
// an app in one file never reloads. A tool that needs the seams —
// extensions, ignore, an injected prelude — writes its own two-line
// --import module calling registerRefresh(options) instead.
import { registerRefresh } from './loader.js';

await registerRefresh();

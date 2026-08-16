// react-x11/refresh/register — hot reload with the defaults, for --import:
//
//   node --enable-source-maps --import react-x11/refresh/register app.jsx
//
// The app's entry needs no changes: the loader injects the runtime wiring
// into every hot module, edits to components apply in place with hook
// state intact, and `onReload` (from react-x11/refresh) is there when a
// tool wants to observe the reloads. A tool that needs the seams —
// extensions, ignore, an injected prelude — writes its own two-line
// --import module calling registerRefresh(options) instead.
import { registerRefresh } from './loader.js';

await registerRefresh();

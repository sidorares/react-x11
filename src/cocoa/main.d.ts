/**
 * `react-x11/cocoa-main` — the cocoa backend's threaded mode, a side-effect
 * entry for `node --import` (`bun --preload`): the app's entry runs on a
 * worker while AppKit keeps the main thread, so menus, drags, live resizes
 * and modal panels no longer stop the app's JS. Does nothing off macOS.
 * No exports.
 */
export {};

// `react-x11/test` — the supported way to test a react-x11 app.
//
// ```js
// import { test, afterEach } from 'node:test';
// import { renderX11, cleanup, screen, userEvent, expectPixel } from 'react-x11/test';
// import { XK_RETURN } from 'react-x11/keysyms';
//
// afterEach(cleanup);
//
// test('adding a task', async () => {
//   const { ctx } = await renderX11(<Tasks />, {
//     fonts: { 'sans-serif': '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf' },
//   });
//   await userEvent.type(screen.getByRole('textbox'), 'buy milk\n');
//   screen.getByText('buy milk');
//   await expectPixel(ctx, 12, 40, '#2980b9', { tolerance: 8 });
// });
// ```
//
// What makes this unusual: there is **no display**. `renderX11` starts
// node-x11's pure-JavaScript X server in this process, connects a real ntk
// client to it over a stream pair, and the test drives that server's own
// input machinery. No `$DISPLAY`, no xvfb, works on macOS, and the pixels
// are real pixels a real X server composited.

import { renderX11 as baseRenderX11, mountedEntries } from './harness.js';
import { screenFor, within } from './queries.js';
import { setDefaultTarget } from './events.js';

export {
  act,
  cleanup,
  settle,
  waitFor,
  withFrameClock,
  windowNodesOf,
} from './harness.js';

export { within, textOf, roleOf } from './queries.js';
export { installA11ySpy, nodeUtterance, utteranceOf } from './a11y.js';
export { inspect, ownerChainOf, sourceOf } from './components.js';
export {
  fireEvent,
  userEvent,
  screenPointOf,
  pointOutsideWindows,
} from './events.js';
export {
  pixelAt,
  expectPixel,
  waitForPixel,
  countPixels,
  isNear,
  toRgb,
  toPNG,
} from './pixels.js';
export { createMockApp, moveMouse, pressButton } from './mock-app.js';
export * from '../keysyms.js';

/**
 * Mount a tree and return a handle to it, plus the queries bound to it — so
 * `const { getByText } = await renderX11(<App/>)` reads the way Testing
 * Library does, and `screen` works for the common single-render case.
 *
 * See {@link ./harness.js} for the options.
 */
export async function renderX11(element, options) {
  const result = await baseRenderX11(element, options);
  // fireEvent.key goes to whatever holds the X input focus, so it only needs
  // a connection; the most recent render is the sensible default
  setDefaultTarget(result.windowNode);
  return Object.assign(result, within(result.windowNode));
}

/**
 * The queries, bound to the most recent `renderX11` — including its popups,
 * since a `<popup>` is a child node of the window that opened it and a menu
 * or dialog is exactly what a test wants to query next.
 */
export const screen = screenFor(() => mountedEntries().at(-1)?.windowNode);

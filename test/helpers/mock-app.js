// The mock ntk application, now published as part of `react-x11/test` —
// this module stays as the in-repo import path.
import { windowNodesOf } from '../../src/testing/harness.js';

export {
  React,
  createMockApp,
  moveMouse,
  pressButton,
  spinWheel,
} from '../../src/testing/mock-app.js';

/**
 * Run the frames a mock window's tree is owed, now: the layout and the paint
 * their clocks would have run later. The mock window has no frame clock, so
 * a frame is a `setImmediate` away and runs in whichever tick the test awaits
 * next; a test that needs the tree laid out from here on says so with this,
 * rather than by counting ticks.
 *
 * The window and every `<popup>` and nested `<window>` in it, each of which
 * runs frames of its own, the way `act()` in `react-x11/test` flushes them.
 */
export function flushFrames(wnd) {
  for (const node of windowNodesOf(wnd._reactX11Node)) {
    if (!node.window) continue;
    // `_scheduled` first: the scheduler reads it as "a frame is already
    // coming", and a frame run out of band has to hand that back, or the
    // next claim schedules nothing (AGENTS.md, "A stalled frame clock under
    // synthetic input")
    node._scheduled = false;
    node.flush();
  }
}

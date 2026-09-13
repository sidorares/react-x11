// A message bus for a test, in this process.
//
// `dbus-native`'s `createBroker()` is a real bus — name ownership,
// org.freedesktop.DBus, routing — so nothing here needs dbus-daemon installed
// or a session to be logged into. The harness starts one, points
// `DBUS_SESSION_BUS_ADDRESS` at it, runs the test, and then unwinds
// everything it caused, on pass and on fail alike.
//
// **The env var is the seam on purpose.** It is how D-Bus itself says "use
// this bus", so the code under test carries no test-only injection path —
// `src/bus.js` reads exactly what a real deployment reads.
//
// The hard close at the end follows from the lifecycle: draining refs no
// longer closes the socket, so without it a connection would survive between
// tests carrying match rules and exported objects. That is the harness
// closing what the harness caused, not a seam into production code.
//
// **Neither helper covers anything outside `fn`.** A call made after one
// returns — or by an effect or a timer that fires later — reads the
// process's own environment, and on a logged-in desktop that is the real
// session bus with the real portal on it. CI has no session bus, so such a
// test stays green there and misbehaves only on a developer's machine. The
// eyedropper suite had one: a pick one line below `withNoBus` found GNOME's
// Screenshot portal, the shell put its colour picker on the screen, and the
// file hung waiting for a click — and while that request stayed open, later
// runs were refused with "There is an ongoing operation for this sender".
// `offTheDesktopBus()` at the top of a file takes all of it off the
// developer's bus, so a dial that slips out finds nothing.

import { after, before } from 'node:test';

import { _resetBusState, closeBus } from '../../src/bus.js';
import { _resetServiceCache } from '../../src/portal.js';

/** An address that names nothing: where `withNoBus()` and
 *  `offTheDesktopBus()` point the session bus. */
const NO_BUS = 'unix:path=/nonexistent/no-bus-here';

/**
 * The transport, loaded on demand — this file is imported by a suite that has
 * to *run* on Node 20, where `dbus-native` is legitimately not installed and a
 * static import would fail before a single test could skip itself.
 */
export async function transportAvailable() {
  try {
    await import('dbus-native');
    return true;
  } catch {
    return false;
  }
}

/**
 * Start a broker, run `fn` against it, and clean up.
 *
 * ```js
 * await withBus(async (address, broker) => {
 *   const ref = await sessionBus();
 *   assert.equal(broker.liveClients, 1);
 * });
 * ```
 *
 * `broker.liveClients` is maintained here rather than by the broker: how many
 * sockets are open is the question most of these tests are actually asking,
 * and counting it from the outside keeps the assertion honest.
 *
 * Only `DBUS_SESSION_BUS_ADDRESS` is pointed at the broker. A test that wants
 * the system bus there too can assign `DBUS_SYSTEM_BUS_ADDRESS` inside `fn`;
 * both are restored afterwards.
 *
 * @param {(address: string, broker: any) => Promise<void>} fn
 */
export async function withBus(fn) {
  const broker = await startBroker();
  const savedSession = process.env.DBUS_SESSION_BUS_ADDRESS;
  const savedSystem = process.env.DBUS_SYSTEM_BUS_ADDRESS;
  process.env.DBUS_SESSION_BUS_ADDRESS = broker.address();
  try {
    await fn(broker.address(), broker);
  } finally {
    restore('DBUS_SESSION_BUS_ADDRESS', savedSession);
    restore('DBUS_SYSTEM_BUS_ADDRESS', savedSystem);
    await closeBus('session').catch(() => {});
    await closeBus('system').catch(() => {});
    _resetBusState();
    await stopBroker(broker);
  }
}

function restore(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/**
 * Run `fn` on a machine with no session bus and no macOS.
 *
 * **The `closeBus()` is load-bearing, not tidying.** The shared connection
 * stays up across acquisitions by design, so pointing the env var at nothing
 * changes what the *next* connect would dial and not what is already open —
 * and a test that skipped this on a developer's own desktop would reach the
 * real portal and put a dialog on their screen, then wait for a human. That
 * is exactly what happened while writing the file-dialog tests.
 *
 * **And only inside `fn`.** The environment goes back on the way out, so an
 * assertion that still needs "no bus here" — a second pick, a late probe —
 * belongs inside the callback, not on the line after it.
 */
export async function withNoBus(fn) {
  const saved = {
    address: process.env.DBUS_SESSION_BUS_ADDRESS,
    runtime: process.env.XDG_RUNTIME_DIR,
    platform: process.platform,
  };
  await closeBus('session').catch(() => {});
  _resetBusState();
  _resetServiceCache();
  process.env.DBUS_SESSION_BUS_ADDRESS = NO_BUS;
  delete process.env.XDG_RUNTIME_DIR;
  Object.defineProperty(process, 'platform', { value: 'linux' });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', { value: saved.platform });
    if (saved.address === undefined)
      delete process.env.DBUS_SESSION_BUS_ADDRESS;
    else process.env.DBUS_SESSION_BUS_ADDRESS = saved.address;
    if (saved.runtime !== undefined)
      process.env.XDG_RUNTIME_DIR = saved.runtime;
    await closeBus('session').catch(() => {});
    _resetBusState();
    _resetServiceCache();
  }
}

/**
 * Take a whole file off the developer's session bus.
 *
 * ```js
 * offTheDesktopBus(); // at the top level of a test file, once
 * ```
 *
 * From the first test to the last, `DBUS_SESSION_BUS_ADDRESS` names nothing
 * and `XDG_RUNTIME_DIR` is gone, so a dial that slips out of `withBus()` or
 * `withNoBus()` finds no bus — the answer CI gives — rather than the desktop
 * the suite happens to be running on. Both helpers still work under it: each
 * saves what it finds, which is now this, and puts that back.
 *
 * The session bus only, since it is the one with a portal on it — the one
 * that can put a dialog on the screen and wait for a human.
 */
export function offTheDesktopBus() {
  const saved = {};
  before(async () => {
    saved.address = process.env.DBUS_SESSION_BUS_ADDRESS;
    saved.runtime = process.env.XDG_RUNTIME_DIR;
    // Closed first, for withNoBus()'s reason: a live connection is handed
    // back whatever the environment says now.
    await closeBus('session').catch(() => {});
    _resetBusState();
    _resetServiceCache();
    process.env.DBUS_SESSION_BUS_ADDRESS = NO_BUS;
    // src/bus.js falls back to `$XDG_RUNTIME_DIR/bus` when the address is
    // unset, and on a desktop that is the real bus again.
    delete process.env.XDG_RUNTIME_DIR;
  });
  after(async () => {
    restore('DBUS_SESSION_BUS_ADDRESS', saved.address);
    restore('XDG_RUNTIME_DIR', saved.runtime);
    await closeBus('session').catch(() => {});
    _resetBusState();
    _resetServiceCache();
  });
}

/** A listening broker, with a live client count attached. */
export async function startBroker(where) {
  const dbus = (await import('dbus-native')).default;
  const broker = dbus.createBroker();
  broker.liveClients = 0;
  broker.on('connection', () => broker.liveClients++);
  broker.on('disconnect', () => broker.liveClients--);
  // A client that dies rudely is a normal thing for these tests to cause;
  // without a listener it would be an unhandled 'error' on an EventEmitter.
  broker.on('clientError', () => {});
  broker.on('error', () => {});
  return new Promise((resolve, reject) => {
    broker.listen(where, (err, address) => {
      if (err) return reject(err);
      broker.on('listening', () => {});
      resolve(Object.assign(broker, { addressString: address }));
    });
  });
}

export function stopBroker(broker) {
  return new Promise((resolve) => broker.close(resolve));
}

/**
 * Wait for a condition, or fail with something more useful than a timeout.
 * Bus state settles across ticks and socket events, not synchronously.
 */
export async function until(predicate, message, timeout = 2000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${message}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

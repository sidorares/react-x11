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

import { _resetBusState, closeBus } from '../../src/bus.js';
import { _resetServiceCache } from '../../src/portal.js';

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
  process.env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/nonexistent/no-bus-here';
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

// Threaded mode's worker half (docs/macos.md §"JS on a worker: a UI thread
// of the bridge's own"): with the launcher (src/cocoa/main.js) holding the
// process main thread in the bridge's `runMain()`, the app's JS runs on a
// `worker_threads` Worker, and this module is what that worker needs to
// talk to the parked thread — the one event channel the bridge allows, and
// the three things a Worker does differently when its main thread never
// returns to its event loop.
//
// The channel's existence is the switch: `createCocoaApp` asks
// `threadedChannel()`, and null is pump mode.
import { Console } from 'node:console';
import fs from 'node:fs';
import { constants } from 'node:os';
import { Writable } from 'node:stream';
import tty from 'node:tty';
import { inspect } from 'node:util';

let channel = null;

// The relaunch's shared state (src/cocoa/relaunch.js), [state, exit code]:
// the main thread waits on it, without AppKit, until the worker says what
// it needs — AppKit, or nothing more because it is done.
export const RELAUNCH = Object.freeze({ WAITING: 0, APPKIT: 1, ENDED: 2 });
let relaunchState = null;

/** The worker's end of the relaunch's shared state. */
export function bindRelaunchState(buffer) {
  relaunchState = buffer ? new Int32Array(buffer) : null;
}

/**
 * Ask the main thread for AppKit, and wait until its run has started. The
 * main thread waits without it, so an app that never makes a cocoa root
 * never launches it; the first cocoa `createRoot` does. Until `runMain`
 * runs the bridge has published nothing — an app that asked `listScreens()`
 * then got `[]` and took scale 1 on a 2x panel (measured) — so the wait is
 * not optional.
 */
export async function requestAppKit(native, state = relaunchState) {
  if (state && Atomics.load(state, 0) === RELAUNCH.WAITING) {
    Atomics.store(state, 0, RELAUNCH.APPKIT);
    Atomics.notify(state, 0);
  }
  while (!native.threaded()) await new Promise((r) => setTimeout(r, 1));
}

/** The worker is done, with `code`: the main thread ends the process. */
export function signalEnded(code, state = relaunchState) {
  if (!state) return;
  Atomics.store(state, 1, Number.parseInt(code, 10) || 0);
  Atomics.store(state, 0, RELAUNCH.ENDED);
  Atomics.notify(state, 0);
}

/**
 * Call `fn(code)` when the worker exits, after every exit listener the app
 * has — its last word. The main thread ends the process on it, and an app's
 * `process.on('exit')` handler must have finished by then, as it has in a
 * process of its own. Kept last by re-adding it whenever the app adds one:
 * Node runs a worker's exit listeners through `process.emit` and Bun calls
 * them directly (measured), so wrapping the emit would cover only Node.
 */
export function onWorkerEnd(fn, proc = process) {
  const add = proc.on;
  const last = (code) => fn(code ?? proc.exitCode ?? 0);
  add.call(proc, 'exit', last);
  for (const name of [
    'on',
    'addListener',
    'once',
    'prependListener',
    'prependOnceListener',
  ]) {
    const method = proc[name];
    proc[name] = function (event, listener) {
      const out = method.call(this, event, listener);
      if (event === 'exit' && listener !== last) {
        proc.removeListener('exit', last);
        add.call(proc, 'exit', last);
      }
      return out;
    };
  }
}

/**
 * Print an uncaught error the way Node prints one, from the worker itself.
 * Node hands a worker's uncaught error to its parent as an event, and the
 * parent here is parked for good — it ends the process on the worker's
 * word and never runs its event loop again to hear it. Only when nothing
 * handles the error: an app's own `uncaughtException` handler means it is
 * not uncaught.
 */
export function printUncaught(
  proc = process,
  write = (s) => proc.stderr.write(s),
) {
  proc.on('uncaughtExceptionMonitor', (err) => {
    if (proc.listenerCount('uncaughtException') > 0) return;
    write(`${inspect(err)}\n`);
  });
}

/** The open channel, or null outside threaded mode. */
export function threadedChannel() {
  return channel;
}

/**
 * `connect` once, and fan each batch out to whoever subscribed: the
 * bootstrap for signals, `CocoaApp` for everything else. The bridge takes
 * one connection per environment, and the bootstrap needs it before the
 * app's entry has run — a Ctrl-C during startup is already an event.
 *
 * What a subscriber throws leaves the delivery once every subscriber has
 * had the batch, and the bridge makes it the worker's uncaught exception
 * (windowkit/appkit#65): the launcher prints it and the process exits 1, as
 * a throw from a click handler ends an X11 app.
 */
export function openThreadedChannel(native) {
  if (channel) return channel;
  const listeners = new Set();
  native.connect((batch) => {
    let failed = false;
    let failure;
    for (const fn of [...listeners]) {
      try {
        fn(batch);
      } catch (err) {
        if (!failed) failure = err;
        failed = true;
      }
    }
    if (failed) throw failure;
  });
  channel = {
    native,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  return channel;
}

/** Forget the channel — the tests' way to run pump and threaded apps in one
 * process. */
export function resetThreadedChannelForTests() {
  channel = null;
}

/**
 * A stream that writes straight to `fd`, synchronously. A Worker's own
 * `process.stdout` forwards every write through its parent's event loop,
 * and the parent here is parked in `[NSApp run]`: without this, everything
 * the app logs is lost (measured). Synchronous, so a line written just
 * before an exit is not lost either; a pipe the main thread opened
 * non-blocking answers EAGAIN when full, and the write waits it out.
 */
export function fdStream(fd, write = fs.writeSync) {
  const stream = new Writable({
    write(chunk, encoding, done) {
      try {
        for (let off = 0; off < chunk.length;) {
          try {
            off += write(fd, chunk, off);
          } catch (err) {
            if (err.code !== 'EAGAIN') throw err;
          }
        }
      } catch (err) {
        done(err);
        return;
      }
      done();
    },
  });
  stream.fd = fd;
  stream.isTTY = tty.isatty(fd);
  // what a colouring library asks a TTY stream, answered as a TTY's would be
  if (stream.isTTY) {
    stream.getColorDepth = tty.WriteStream.prototype.getColorDepth;
    stream.hasColors = tty.WriteStream.prototype.hasColors;
  }
  return stream;
}

/**
 * Stdout and stderr on fds 1 and 2, and a console over them — the console
 * too, because Bun's writes past `process.stdout` altogether.
 */
export function installStdio(proc = process, global = globalThis) {
  const stdout = fdStream(1);
  const stderr = fdStream(2);
  Object.defineProperty(proc, 'stdout', {
    configurable: true,
    get: () => stdout,
  });
  Object.defineProperty(proc, 'stderr', {
    configurable: true,
    get: () => stderr,
  });
  Object.defineProperty(global, 'console', {
    configurable: true,
    writable: true,
    value: new Console({ stdout, stderr }),
  });
}

/**
 * `process.exit` inside a Worker ends the worker and nothing else: the main
 * thread stays in `[NSApp run]` with nothing left to end it, a Dock tile
 * for an app that is gone (measured). So an exit asks the main thread
 * first — `requestExit` makes `runMain` return the code, and the launcher
 * ends the process with it — and then ends the worker as before, so the
 * code after an exit still never runs. Node's own handling of an uncaught
 * error calls `process.exit()` too, which is how a crash reaches the
 * launcher with its code.
 */
export function routeExit(native, proc = process) {
  const exitWorker = proc.exit.bind(proc);
  proc.exit = (code) => {
    const n = Number.parseInt(code ?? proc.exitCode ?? 0, 10);
    native.requestExit(Number.isFinite(n) ? n : 0);
    return exitWorker(code);
  };
}

/**
 * A handler for the channel that gives the worker its signals back. Node
 * delivers SIGINT, SIGTERM and SIGHUP to the main thread only, which is
 * parked, so the bridge reads them there and sends each as an event; this
 * re-emits it on the worker's `process`, where the app's
 * `process.on('SIGINT')` is. A signal nobody listens for ends the process
 * the way the signal would have: 128 + its number.
 */
export function forwardSignals(proc = process) {
  return (batch) => {
    for (const ev of batch) {
      if (ev.type !== 'signal') continue;
      const name = ev.signal;
      if (proc.listenerCount(name) > 0) proc.emit(name, name);
      else proc.exit(128 + (constants.signals[name] ?? 0));
    }
  };
}

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

let channel = null;

const rethrowLater = (err) =>
  setImmediate(() => {
    throw err;
  });

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
 * What a subscriber throws is thrown again from a turn of its own
 * (`rethrow`), where it is the worker's uncaught exception: the launcher
 * prints it and the process exits 1, as a throw from a click handler ends
 * an X11 app. Left to propagate out of the delivery it would be swallowed —
 * the bridge leaves an exception from its batch callback pending, and
 * Node's default policy for one out of a threadsafe function's callback is
 * a warning on a stderr nobody reads here (measured 2026-09-11: the window
 * stayed up and the error was gone).
 */
export function openThreadedChannel(native, { rethrow = rethrowLater } = {}) {
  if (channel) return channel;
  const listeners = new Set();
  native.connect((batch) => {
    for (const fn of [...listeners]) {
      try {
        fn(batch);
      } catch (err) {
        rethrow(err);
      }
    }
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

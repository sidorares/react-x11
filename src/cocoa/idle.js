// How long since anybody touched the Mac — the number `useIdle()` asks the
// app for as `lastInputMs()` (src/idle.js), the same shape the win32 backend
// answers with `GetLastInputInfo`. Without it nothing on this backend could
// answer: every other rung of that ladder reaches into `app.X`, and the cocoa
// `X` is a stub with no SYNC and no MIT-SCREEN-SAVER behind it, so
// `useIdle()` stayed `false` on a Mac that had sat untouched for an hour
// (#938).
//
// Two rungs, the bridge's verb over a shell-out, the way the file dialog and
// the notifications have them:
//
// 1. **`lastInputMs()` on the bridge**, where it has one: CoreGraphics'
//    `CGEventSourceSecondsSinceLastEventType` over the combined session state
//    and any input event type, in milliseconds. A call into the window
//    server's own count, needing no AppKit and no main thread, so it is
//    asked synchronously from a worker too.
// 2. **`ioreg`**, beneath it. IOHIDSystem publishes `HIDIdleTime` —
//    nanoseconds since the last HID event, on any device, whichever app it
//    went to — as a registry property, and `ioreg` prints it: one short-lived
//    child, about 20 ms of wall clock and a millisecond of CPU. That is only
//    affordable because of how src/idle.js asks: the remaining time while the
//    user is there (one child per timeout), and a scaled interval while they
//    are away (a quarter of the timeout, from a second up to half a minute:
//    every 30 s for five minutes) — and only while a component is subscribed.
//    Two timeouts asking at once share one child.
//
// Both count input on the whole session rather than in this process, which
// is what an idle timeout means.

/** IOHIDSystem's property, in nanoseconds; `-d 1` stops at the one entry. */
const IOREG = '/usr/sbin/ioreg';
const IOREG_ARGS = ['-c', 'IOHIDSystem', '-r', '-d', '1', '-k', 'HIDIdleTime'];

/**
 * Test seam, not public: what runs `ioreg`, as `(file, args) => Promise<stdout>`.
 * A fake here lets the rung run off a Mac, where the real one cannot.
 */
let runIoreg = null;
export function _setIoregForTests(fn) {
  runIoreg = fn;
}

async function execIoreg(file, args) {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', timeout: 5_000 }, (err, out) =>
      err ? reject(err) : resolve(String(out ?? '')),
    );
  });
}

/** `"HIDIdleTime" = 3588594533583` → milliseconds, or null. */
export function hidIdleMs(stdout) {
  const match = /"HIDIdleTime"\s*=\s*(\d+)/.exec(stdout);
  return match ? Number(match[1]) / 1e6 : null;
}

/**
 * The app's `lastInputMs`: the bridge's verb where it has one, and the
 * `ioreg` reader where it does not. Never throws; the reader resolves `null`
 * when `ioreg` could not answer, which src/idle.js takes as "ask again
 * later" rather than as an answer.
 */
export function lastInputReader(native) {
  if (typeof native.lastInputMs === 'function') {
    return () => native.lastInputMs();
  }
  let pending = null;
  let warned = false;
  return () => {
    pending ??= (runIoreg ?? execIoreg)(IOREG, IOREG_ARGS)
      .then(hidIdleMs, (err) => {
        // A Mac always has `ioreg`, so one that cannot run it is a sandbox or
        // a stripped image, and `useIdle()` would sit at `false` there with
        // nothing to say why. Said once, in development.
        if (!warned && process.env.NODE_ENV !== 'production') {
          warned = true;
          console.warn(
            'react-x11: useIdle() cannot read the idle time — this ' +
              '@windowkit/appkit has no lastInputMs, and ' +
              `\`${IOREG}\` failed: ${err?.message ?? err}. It answers ` +
              'false meanwhile, and asks ioreg again a timeout later.',
          );
        }
        return null;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };
}

// A countdown timer — everything an application has to do besides draw.
//
//   npm run examples:timer
//   npm run examples:timer -- 25m 5m           # timers from argv
//   TIMER_LOG=debug npm run examples:timer     # the app's own log, on stderr
//
// The other examples are about pixels: layout, text, drawing, events. This
// one is about the rest of the job, which is the part that decides whether a
// program feels like a desktop application or like a window that happens to
// be open. It starts once and only once, answers a link the desktop hands
// it, tells the session it is up, keeps the screen from blanking while it is
// counting, notifies through the desktop's own service when it finishes —
// and does every one of those things on a machine that offers none of them,
// because "no session bus" is where react-x11 spends much of its life.
//
// ## What to try
//
//   Start a timer     the countdown is a *deadline*, not a decrementing
//                     number — see "the one design decision" below.
//   Close the lid     and open it again. The timer is correct on wake, which
//                     a tick-based one would not be.
//   Deep link         with it running, from another terminal:
//
//                       gio open com.example.x11timer://start/2m/Tea
//
//                     no second copy starts, the window comes forward, and
//                     the timer is running. Closed, the same command starts
//                     the app *and* the timer.
//   No bus            `env -u DBUS_SESSION_BUS_ADDRESS npm run examples:timer`
//                     — every feature above degrades and the footer says
//                     which. This is the configuration to check first, not
//                     last: macOS, ssh, a bare startx and CI are all here.
//
// ## The one design decision
//
// **A timer is a deadline, not a countdown.** The obvious implementation
// subtracts the tick interval from a remaining count every tick, and it is
// wrong three ways: `setTimeout` is a floor and not a promise, so every late
// tick is lost time that never comes back; a busy machine loses more; and a
// laptop that suspends stops ticking entirely, so a 25-minute timer set
// before lunch has 24 minutes left after it.
//
// Storing the absolute moment it ends and deriving `remaining = deadline -
// now` fixes all three at once, because the clock kept running while nothing
// was watching it. The tick then exists only to re-render, and its interval
// is a question about smoothness rather than about correctness — which is
// why it can be 250ms without anyone auditing the arithmetic.
//
// The seam that makes this testable is `clock`: `now()` plus an `every()`
// that the tests drive by hand. A test that asserts a countdown by sleeping
// is a slow test that is also flaky, and it cannot reach the case above at
// all — `manualClock().sleep(30 * 60_000)` is a closed lid, in one statement
// and in no time.
//
// ## Packaging
//
// `docs/packaging.md` has the four tiers; the D-Bus half needs a desktop
// entry either way, because the *bus* is what starts the app for a link that
// arrives while it is closed:
//
//   ~/.local/share/applications/com.example.x11timer.desktop
//
//     [Desktop Entry]
//     Type=Application
//     Name=Timer
//     Exec=/path/to/npx tsx /path/to/examples/timer.jsx %u
//     DBusActivatable=true
//     StartupWMClass=com.example.x11timer
//     MimeType=x-scheme-handler/com.example.x11timer;
//
//   ~/.local/share/dbus-1/services/com.example.x11timer.service
//
//     [D-BUS Service]
//     Name=com.example.x11timer
//     Exec=/path/to/npx tsx /path/to/examples/timer.jsx
//
//   update-desktop-database ~/.local/share/applications
//
// `examples/urischeme.jsx` is the harness for checking that wiring itself;
// this file assumes it and gets on with being a timer.
//
// ## What does not work
//
// **Nothing here can stop a suspend** — `useKeepAwake` inhibits screen
// blanking on all three of its rungs and nothing more (`docs/system.md`), so
// a lid closed over a running timer still sleeps. The deadline survives it;
// the notification is simply late, arriving on the first tick after wake.
//
// **No tray icon.** `<TrayHost>` lives in `@react-x11/components`, and an
// example here does not import it (`AGENTS.md`). A timer minimised to a tray
// is the natural shape for this app and it is the one thing this file cannot
// show.
import React, { useCallback, useEffect, useMemo, useState } from 'react';

import {
  Button,
  ProgressBar,
  activateWindow,
  createRoot,
  createStyles,
  launchTimestamp,
  notifyStartupComplete,
  registerApplication,
  useAppActivate,
  useAppOpen,
  useKeepAwake,
  useSessionBus,
  useTopLevelWindow,
} from '../src/index.js';

const APP_ID = 'com.example.x11timer';
const TICK_MS = 250;

// ---------------------------------------------------------------------------
// Seam 1: the clock
//
// `every()` returns its own canceller rather than an id, so a caller cannot
// hold the wrong kind of handle, and `manualClock` can be a plain object with
// no timer machinery in it at all.
// ---------------------------------------------------------------------------

export function systemClock() {
  return {
    now: () => Date.now(),
    every(ms, fn) {
      const id = setInterval(fn, ms);
      return () => clearInterval(id);
    },
  };
}

/**
 * The test clock, with the two ways time passes.
 *
 * `advance` is time passing while the process runs: every tick in between
 * fires. `sleep` is time passing while it does not — a suspended laptop, or
 * an event loop blocked long enough to amount to the same thing — so no tick
 * fires in the gap and exactly one fires on the far side, which is what a
 * real `setInterval` does on wake.
 *
 * Both are needed. A fake with only `advance` cannot express the case this
 * app is designed around, and one with only `sleep` would let a tick-driven
 * countdown pass every test in the file.
 */
export function manualClock(start = 1_700_000_000_000) {
  let t = start;
  const ticks = new Set();
  return {
    now: () => t,
    every(ms, fn) {
      const entry = { ms, fn, due: t + ms };
      ticks.add(entry);
      return () => ticks.delete(entry);
    },
    advance(ms) {
      const until = t + ms;
      // Every tick that falls inside the jump, in order, so a long advance is
      // not silently one tick.
      for (;;) {
        let next = null;
        for (const e of ticks) if (!next || e.due < next.due) next = e;
        if (!next || next.due > until) break;
        t = next.due;
        next.due = t + next.ms;
        next.fn();
      }
      t = until;
    },
    sleep(ms) {
      t += ms;
      for (const e of ticks) {
        e.due = t + e.ms;
        e.fn();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Seam 2: the notifier
//
// `org.freedesktop.Notifications` is a plain D-Bus call, so this is what
// "core gives you the bus, not the service" looks like from an app's side:
// twenty lines, no dependency, and the app decides what happens when the
// service is not there.
// ---------------------------------------------------------------------------

const NOTIFY = {
  destination: 'org.freedesktop.Notifications',
  path: '/org/freedesktop/Notifications',
  interface: 'org.freedesktop.Notifications',
};

export function busNotifier(bus) {
  return {
    kind: 'desktop',
    async notify({ title, body }) {
      // susssasa{sv}i — app_name, replaces_id, icon, summary, body, actions,
      // hints, expire_timeout. -1 is "the desktop's own default", which is
      // the right answer for an alarm: the user decides how long it stays.
      await bus.invoke(
        {
          ...NOTIFY,
          member: 'Notify',
          signature: 'susssasa{sv}i',
          body: ['Timer', 0, 'alarm-symbolic', title, body, [], [], -1],
        },
        { timeout: 5_000 },
      );
    },
  };
}

/**
 * What runs when there is no bus, which is not an error path — it is macOS,
 * ssh, a container, and CI. The terminal bell is a real notification on a
 * machine with nothing else, and the banner in the window is the rest of it.
 */
export function localNotifier(write = (text) => process.stdout.write(text)) {
  return {
    kind: 'local',
    async notify() {
      write('');
    },
  };
}

// ---------------------------------------------------------------------------
// The log
//
// One line per event, on stderr, structured. An app's log is the thing that
// answers "what happened" on a machine you cannot attach to, so it holds the
// facts a support question needs — which is not the same list as the ones a
// developer wants while writing it.
//
// `REACT_X11_TRACE=1` is the other half, one layer down (docs/debugging.md).
// ---------------------------------------------------------------------------

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

export function createLog(level = process.env.TIMER_LOG ?? 'info', sink) {
  const max = LEVELS[level] ?? LEVELS.info;
  const write = sink ?? ((line) => process.stderr.write(`${line}\n`));
  return (lvl, event, fields = {}) => {
    if ((LEVELS[lvl] ?? 9) > max) return;
    write(
      JSON.stringify({ t: new Date().toISOString(), lvl, event, ...fields }),
    );
  };
}

// ---------------------------------------------------------------------------
// The model — pure, and therefore the part with no tests of its own: every
// assertion about it is an assertion about the window.
// ---------------------------------------------------------------------------

let nextId = 1;
const makeTimer = (label, ms) => ({
  id: `t${nextId++}`,
  label,
  ms,
  left: ms,
  deadline: null,
  state: 'idle', // 'idle' | 'running' | 'paused' | 'done'
});

const DEFAULTS = [
  ['Pomodoro', 25 * 60_000],
  ['Break', 5 * 60_000],
  ['Tea', 3 * 60_000],
];

export const remainingOf = (t, now) =>
  t.state === 'running' ? Math.max(0, t.deadline - now) : t.left;

/** `4:59`, `1:04:59` — and never `0:60`, which is what rounding up gives. */
export function formatClock(ms) {
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** `25m`, `90s`, `1h30m`, `25` (minutes). Null when it is not a duration. */
export function parseDuration(text) {
  const trimmed = String(text).trim().toLowerCase();
  if (!trimmed) return null;
  if (/^\d+(\.\d+)?$/.test(trimmed))
    return Math.round(Number(trimmed) * 60_000);
  const re = /(\d+(?:\.\d+)?)\s*(h|m|s)/g;
  let total = 0;
  let seen = 0;
  let match;
  while ((match = re.exec(trimmed))) {
    const n = Number(match[1]);
    total += n * { h: 3_600_000, m: 60_000, s: 1000 }[match[2]];
    seen += match[0].length;
  }
  // Every character has to be part of a unit, or `25 monkeys` is 25 minutes.
  return seen === trimmed.replace(/\s/g, '').length && total > 0 ? total : null;
}

/** `com.example.x11timer://start/25m/Tea` → `{ ms, label }`, or null. */
export function parseTimerUri(uri) {
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${APP_ID}:`) return null;
  // `//start/25m/Tea` puts `start` in the host and the rest in the path; a
  // link written without the slashes puts all of it in the path. Both are
  // things people type, so both work.
  const parts = [parsed.host, ...parsed.pathname.split('/')].filter(Boolean);
  if (parts[0] !== 'start') return null;
  const ms = parseDuration(parts[1] ?? '');
  return ms ? { ms, label: decodeURIComponent(parts[2] ?? 'Timer') } : null;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const s = createStyles({
  root: {
    flexGrow: 1,
    flexDirection: 'column',
    backgroundColor: '$background',
  },
  body: { flexGrow: 1, flexDirection: 'column', gap: 8, padding: 14 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingStart: 12,
    paddingEnd: 10,
    paddingTop: 8,
    paddingBottom: 8,
    borderRadius: 8,
    backgroundColor: '$surface',
    ':focus-within': { backgroundColor: '$surfaceHover' },
  },
  rowDone: { backgroundColor: '$surfaceActive' },
  label: { color: '$text', fontSize: 13, width: 110 },
  clock: {
    color: '$text',
    fontSize: 26,
    width: 118,
    textAlign: 'end',
  },
  clockDone: { color: '$success' },
  bar: { flexGrow: 1, minWidth: 60 },
  add: { flexDirection: 'row', gap: 8, alignItems: 'center', paddingTop: 4 },
  field: {
    width: 96,
    height: 30,
    borderWidth: 1,
    borderColor: '$border',
    borderRadius: 6,
    paddingStart: 8,
    paddingEnd: 8,
    backgroundColor: '$surface',
    ':focus': { borderColor: '$accent' },
  },
  fieldWide: { width: 150 },
  bad: { borderColor: '$danger' },
  foot: {
    flexDirection: 'column',
    gap: 2,
    paddingStart: 14,
    paddingEnd: 14,
    paddingTop: 8,
    paddingBottom: 10,
    borderTopWidth: 1,
    borderColor: '$border',
  },
  dim: { color: '$textMuted', fontSize: 11 },
  banner: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    padding: 10,
    borderRadius: 8,
    backgroundColor: '$surfaceActive',
    // Uniform: a start-only border with a radius is painted square, and the
    // renderer says so.
    borderWidth: 1,
    borderColor: '$success',
  },
  bannerText: { color: '$text', fontSize: 12, flexGrow: 1 },
  error: { color: '$danger', fontSize: 12 },
});

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

function TimerRow({ timer, now, onStart, onPause, onReset }) {
  const left = remainingOf(timer, now);
  const done = timer.state === 'done';
  const running = timer.state === 'running';
  return (
    <box
      style={[s.row, done && s.rowDone]}
      role="group"
      aria-label={timer.label}
      data-testname="timer"
    >
      <text style={s.label}>{timer.label}</text>
      <text style={[s.clock, done && s.clockDone]}>{formatClock(left)}</text>
      <box style={s.bar}>
        <ProgressBar
          value={timer.ms ? 1 - left / timer.ms : 0}
          aria-label={`${timer.label} progress`}
        />
      </box>
      {running ? (
        <Button onPress={onPause} aria-label={`Pause ${timer.label}`}>
          Pause
        </Button>
      ) : (
        <Button onPress={onStart} aria-label={`Start ${timer.label}`}>
          {done || timer.left === timer.ms ? 'Start' : 'Resume'}
        </Button>
      )}
      <Button onPress={onReset} aria-label={`Reset ${timer.label}`}>
        Reset
      </Button>
    </box>
  );
}

function AddTimer({ onAdd }) {
  const [label, setLabel] = useState('');
  const [duration, setDuration] = useState('');
  const ms = parseDuration(duration);
  const bad = duration.trim() !== '' && ms === null;

  const submit = () => {
    if (!ms) return;
    onAdd(label.trim() || 'Timer', ms);
    setLabel('');
    setDuration('');
  };

  return (
    <box style={s.add}>
      <textinput
        style={[s.field, s.fieldWide]}
        value={label}
        placeholder="what for"
        aria-label="Timer name"
        onChange={(ev) => setLabel(ev.value)}
        onKeyDown={(ev) => ev.key === 'Return' && submit()}
      />
      <textinput
        style={[s.field, bad && s.bad]}
        value={duration}
        placeholder="25m"
        aria-label="Duration"
        onChange={(ev) => setDuration(ev.value)}
        onKeyDown={(ev) => ev.key === 'Return' && submit()}
      />
      <Button primary disabled={!ms} onPress={submit}>
        Add
      </Button>
      {bad ? <text style={s.error}>not a duration</text> : null}
    </box>
  );
}

/**
 * Why there is no desktop notifier, short enough to be a status line. The
 * bus's own message is a paragraph — on macOS it names the launchd socket
 * and suggests `brew services start dbus` — which is exactly right in a log
 * and wrong in a footer, so the window keeps the clause and the log keeps
 * the paragraph.
 */
function whyNot(bus) {
  if (bus.status !== 'unavailable') return bus.status;
  const said = bus.cause?.message?.replace(/^react-x11: /, '');
  return said ? said.split(' (')[0] : 'no session bus';
}

/**
 * The compatibility ladder, stated in the window. Every example that talks to
 * the desktop ends up needing one of these: the alternative is an app that
 * silently does less on the machine it is running on, and a user with no way
 * to find out why.
 */
function StatusLine({ bus, notifier, startedIn }) {
  const how =
    notifier.kind === 'desktop'
      ? 'notifications: the desktop'
      : `notifications: terminal bell — ${whyNot(bus)}`;
  return (
    <box style={s.foot} data-testname="status">
      <text style={s.dim}>{how}</text>
      <text style={s.dim}>
        {`${APP_ID}://start/25m/Tea${
          startedIn == null ? '' : `   ·   up in ${startedIn}ms`
        }`}
      </text>
    </box>
  );
}

class Boundary extends React.Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // The app's log, not the console: this is the line that has to exist on
    // a machine nobody is watching.
    this.props.log('error', 'render-failed', {
      message: String(error?.message ?? error),
      component: info?.componentStack?.split('\n')[1]?.trim(),
    });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <box style={s.body}>
        <text style={s.error}>
          {`This pane stopped: ${this.state.error.message}`}
        </text>
        <Button onPress={() => this.setState({ error: null })}>
          Try again
        </Button>
      </box>
    );
  }
}

export function TimerPanel({
  clock = systemClock(),
  notifier: given = null,
  log = createLog(),
  initial = DEFAULTS,
}) {
  const bus = useSessionBus();
  const notifier = useMemo(
    () => given ?? (bus.bus ? busNotifier(bus.bus) : localNotifier()),
    [given, bus.bus],
  );

  const [timers, setTimers] = useState(() =>
    initial.map(([label, ms]) => makeTimer(label, ms)),
  );
  const [now, setNow] = useState(() => clock.now());
  const [rang, setRang] = useState(null);
  const [startedIn, setStartedIn] = useState(null);
  // The panel does not own the window — `App` does, and the screenshot
  // scripts and tests mount the panel without one. This is the hook for
  // "whatever window I am in", which is what a raise needs.
  const win = useTopLevelWindow();

  const running = timers.some((t) => t.state === 'running');

  // The tick exists to re-render, and for nothing else — see the header. It
  // does not run when nothing is counting, so an idle window is an idle
  // process: no wakeups, which is the difference between a timer you leave
  // open and one you close to save the battery.
  useEffect(() => {
    if (!running) return undefined;
    return clock.every(TICK_MS, () => setNow(clock.now()));
  }, [running, clock]);

  // Expiry is a *transition*, so it belongs in an effect and not in the tick:
  // by the time this has run once the timer's state is 'done', which is what
  // makes "it notifies exactly once" true rather than merely usually true.
  useEffect(() => {
    const due = timers.filter(
      (t) => t.state === 'running' && t.deadline <= now,
    );
    if (!due.length) return;
    setTimers((prev) =>
      prev.map((t) =>
        due.some((d) => d.id === t.id)
          ? { ...t, state: 'done', left: 0, deadline: null }
          : t,
      ),
    );
    for (const t of due) {
      log('info', 'timer-finished', { label: t.label, ms: t.ms });
      setRang(t.label);
      // A notifier that rejects — no service, a timeout, a desktop that went
      // away — must not stop the clock. This is the whole of the app's error
      // handling for the outside world: log it, keep counting.
      notifier
        .notify({ title: `${t.label} finished`, body: formatClock(t.ms) })
        .catch((err) =>
          log('warn', 'notify-failed', {
            message: String(err?.message ?? err),
          }),
        );
    }
  }, [now, timers, notifier, log]);

  useKeepAwake(running, 'A timer is counting down');

  // The paragraph the footer does not have room for. Logged once, when the
  // answer arrives — "why are there no notifications on this machine" is a
  // support question, and this is the line that answers it.
  useEffect(() => {
    if (bus.status === 'unavailable')
      log('info', 'no-session-bus', { cause: bus.cause?.message });
  }, [bus.status, bus.cause, log]);

  const start = useCallback(
    (id) =>
      setTimers((prev) =>
        prev.map((t) => {
          if (t.id !== id) return t;
          const left = t.state === 'done' ? t.ms : t.left;
          return { ...t, state: 'running', left, deadline: clock.now() + left };
        }),
      ),
    [clock],
  );

  const pause = useCallback(
    (id) =>
      setTimers((prev) =>
        prev.map((t) =>
          t.id === id && t.state === 'running'
            ? {
                ...t,
                state: 'paused',
                left: remainingOf(t, clock.now()),
                deadline: null,
              }
            : t,
        ),
      ),
    [clock],
  );

  const reset = useCallback(
    (id) =>
      setTimers((prev) =>
        prev.map((t) =>
          t.id === id ? { ...t, state: 'idle', left: t.ms, deadline: null } : t,
        ),
      ),
    [],
  );

  const add = useCallback(
    (label, ms, andStart = false) =>
      setTimers((prev) => {
        const t = makeTimer(label, ms);
        return [
          ...prev,
          andStart ? { ...t, state: 'running', deadline: clock.now() + ms } : t,
        ];
      }),
    [clock],
  );

  // A link is a command, and the only one this app takes. `activateWindow`
  // with the launch's own timestamp is what lets the window come forward —
  // without it the window manager is entitled to blink the taskbar instead.
  useAppOpen((uris, ctx) => {
    for (const uri of uris) {
      const parsed = parseTimerUri(uri);
      log(parsed ? 'info' : 'warn', 'uri', { uri, ok: Boolean(parsed) });
      if (parsed) add(parsed.label, parsed.ms, true);
    }
    activateWindow(win, { timestamp: ctx.timestamp });
  });

  useAppActivate((ctx) => activateWindow(win, { timestamp: ctx.timestamp }));

  // "Up" is the first frame, not the first line of main: a startup
  // notification cancelled any earlier leaves the desktop's busy cursor
  // spinning over a window that is already there.
  useEffect(() => {
    notifyStartupComplete();
    const since = launchTimestamp();
    if (since != null) setStartedIn(Date.now() - since);
    log('info', 'ready', { timers: timers.length });
    // Empty deps on purpose: "ready" happens exactly once, and everything
    // this body reads changes while the app runs.
  }, []);

  return (
    <>
      <Boundary log={log}>
        <box style={s.body} data-testname="timers">
          {rang ? (
            <box style={s.banner} role="status">
              <text style={s.bannerText}>{`${rang} finished`}</text>
              <Button onPress={() => setRang(null)} aria-label="Dismiss">
                Dismiss
              </Button>
            </box>
          ) : null}

          {timers.map((t) => (
            <TimerRow
              key={t.id}
              timer={t}
              now={now}
              onStart={() => start(t.id)}
              onPause={() => pause(t.id)}
              onReset={() => reset(t.id)}
            />
          ))}

          <AddTimer onAdd={add} />
        </box>
      </Boundary>
      <StatusLine bus={bus} notifier={notifier} startedIn={startedIn} />
    </>
  );
}

function App(props) {
  return (
    <window
      width={620}
      height={430}
      wmClass={APP_ID}
      title="Timer"
      style={s.root}
    >
      <TimerPanel {...props} />
    </window>
  );
}

export default App;

// ---------------------------------------------------------------------------
// Bootstrap
//
// The order is the point. `registerApplication()` goes before `createRoot()`
// because on the D-Bus path the bus *started this process* to answer an Open
// call that is outstanding while the app boots (docs/uri-schemes.md).
// ---------------------------------------------------------------------------

if (!process.env.REACT_X11_NO_AUTORUN) {
  const log = createLog();

  const registration = await registerApplication({
    appId: APP_ID,
    schemes: [APP_ID],
  });
  log('info', 'registered', {
    role: registration?.role ?? 'none',
    bus: Boolean(registration),
  });

  // Timers named on the command line, so `npm run examples:timer -- 25m 5m`
  // works with no desktop integration at all.
  const argv = process.argv
    .slice(2)
    .map((a) => [a, parseDuration(a)])
    .filter(([, ms]) => ms);

  const root = await createRoot({
    // Where a crash goes on a machine nobody is watching. React calls these
    // instead of rethrowing to the console, so an app that does not pass them
    // has no record of its own failures.
    onUncaughtError: (error) =>
      log('error', 'uncaught', { message: String(error?.message ?? error) }),
    onCaughtError: (error) =>
      log('warn', 'caught', { message: String(error?.message ?? error) }),
  });

  root.render(<App log={log} initial={argv.length ? argv : DEFAULTS} />);
}

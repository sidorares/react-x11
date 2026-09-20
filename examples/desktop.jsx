// Everything an app does *outside* its own window, in one app — and the pane
// that says which of it this machine can actually do.
//
//   npm run examples:desktop                          # freedesktop: tray, launcher, daemon
//   REACT_X11_BACKEND=cocoa npm run examples:desktop   # NSStatusItem + NSDockTile
//
// `badge.jsx` is the launcher, `tray.jsx` is the tray and `notify.jsx` is the
// notification. This one is the **ladder itself**: a backup agent that uses
// every desktop hook at once, and whose second pane is a live readout of what
// each of them landed on. It is the example to read when the question is
// "what will my app get on the machine I do not have".
//
// ## What to try
//
//   Back up now     the tray icon changes, a progress bar crosses the
//                   launcher icon (`useProgress`) and the tray's title counts
//                   the percentage. Pause and it holds.
//
//   Let it hit a    two files come back changed on both sides. The badge
//   conflict        counts them (`useBadge`), the launcher entry goes
//                   **urgent** (`setUrgent`), and the tray switches to its
//                   attention icon (`attention: true` → the panel's
//                   `NeedsAttention`). Resolve them and all three clear —
//                   asking for attention you have already been given is the
//                   fastest way to be ignored.
//
//   Right-click     the tray icon, or the app's icon in the dock. The same
//                   `items` array feeds both: `useLauncherMenu` is the launcher
//                   protocol's **quicklist** on Linux now, not macOS alone.
//
//   Scroll over     the tray icon: the rate limit moves. `Scroll` is in the
//   the tray        freedesktop protocol and not in `NSStatusItem`, so the
//                   row is dimmed where `features.scroll` is false rather
//                   than sitting there doing nothing.
//
//   Show tray icon  the checkbox in **This desktop**. Its enabled state comes
//                   from `useDesktopCapability('tray')`, *not* from
//                   `useTray()` — a settings screen has to know whether a
//                   tray would take an icon without putting one there to find
//                   out. That is the distinction the two hooks exist to draw,
//                   and the pane shows both answers at once.
//
//   Stop your panel while it runs — quit Plasma's tray applet, toggle the
//                   AppIndicator extension off. Nothing throws and nothing is
//                   logged: `available` flips back, the pane re-reads, and
//                   the window carries on. Start it again and the icon comes
//                   back, because no answer here is ever cached.
//
// ## Measure, predict, and the one thing that is neither
//
//   - **`useTray()` measures.** It tried to put *this* icon in a tray, so its
//     `available` is what happened, and its `error` is a tray that answered
//     and then refused — a different fact from a desktop with no tray, and
//     the only one of the two with a fix.
//   - **`useDesktopCapability(name)` predicts**, which is what the settings
//     rows need.
//   - **`features` is what you branch on.** Never the platform, and not
//     `backend` either: `backend` is for the footer and for bug reports.
//
// The one exception is `ICONS` below — icon *names* are two vocabularies, SF
// Symbols and the desktop's icon theme, and no feature flag papers over that.
// It is the only thing in the file picked by mechanism.
//
// ## The seam
//
// `fixtureBackup()` is the world: a timer, a file count, and two conflicts on
// the way through. A real one would be walking a tree and talking to a
// server. `tickMs: 0` never advances on its own, which is how
// `test/desktop-example.test.js` drives this same app a step at a time
// (AGENTS.md, "put a seam where the world is").
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  CAPABILITIES,
  createRoot,
  desktopCapability,
  registerApplication,
  setBadge,
  setProgress,
  setLauncherMenu,
  setUrgent,
  useApp,
  useBadge,
  useDesktopCapability,
  useLauncherMenu,
  useNotifier,
  useProgress,
  useTray,
} from '../src/index.js';

const APP_ID = 'com.example.x11backup';

// ---------------------------------------------------------------------------
// The desktop entry, which is the half of the launcher that is not code.
//
// `setBadge`/`setLauncherMenu` resolve **true** with no `.desktop` file installed
// — and nothing appears. That is not a bug in either: the signal is addressed
// to `application://<APP_ID>.desktop`, so it is delivered correctly and simply
// matches no icon. The launcher has to be able to find (a) an entry of that
// name and (b) *this window* as belonging to it, and the second half is the
// one that catches people out:
//
//   Wayland   the toplevel's xdg `app_id`, which is `createRoot({ appId })`
//             or `<window appId>` — **not** `registerApplication({ appId })`,
//             which is a different identity that happens to share a spelling.
//   X11       `WM_CLASS`, i.e. `<window appId>`, matched against the
//             entry's `StartupWMClass=`.
//
// So the id is stated in three places on purpose here, and they must agree.
// `capabilities` reports `needsDesktopFile: true` for this rung to say that
// availability on the bus is not the whole story.
// ---------------------------------------------------------------------------

const DESKTOP_ENTRY = `[Desktop Entry]
Type=Application
Name=Backup (react-x11 example)
Comment=The desktop-integration example
Exec=${'${EXEC}'}
Icon=drive-harddisk
Terminal=false
Categories=Utility;
StartupWMClass=${APP_ID}
Actions=NewWindow;

[Desktop Action NewWindow]
Name=New Window (a static .desktop action)
Exec=${'${EXEC}'}
`;

/** Where a per-user entry goes, without naming `node:path` in a JSX example. */
function desktopEntryPath() {
  const home = globalThis.process?.env?.HOME ?? '';
  const dataHome =
    globalThis.process?.env?.XDG_DATA_HOME || `${home}/.local/share`;
  return `${dataHome}/applications/${APP_ID}.desktop`;
}

/** Is one installed? Read once per mount — installing it is a manual step, so
 *  polling would be watching for something that cannot happen mid-run. */
async function desktopEntryInstalled() {
  try {
    const fs = await import(/* @vite-ignore */ 'node:fs/promises');
    await fs.access(desktopEntryPath());
    return true;
  } catch {
    return false;
  }
}

/** `--install-desktop-entry`, so the example can be made to work in one go. */
async function installDesktopEntry() {
  const fs = await import(/* @vite-ignore */ 'node:fs/promises');
  const target = desktopEntryPath();
  const proc = globalThis.process;
  // Point `Exec` at however this copy was started, so the entry launches the
  // same example rather than a binary that may not be on PATH — **including
  // the loader flags**. `argv` alone would write `node …/desktop.jsx`, and
  // node cannot run JSX: the `--import tsx` that made this process work lives
  // in `execArgv`, and dropping it writes an entry that fails on click.
  const exec = [
    proc?.execPath ?? 'node',
    ...(proc?.execArgv ?? []),
    proc?.argv?.[1] ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  await fs.mkdir(target.slice(0, target.lastIndexOf('/')), { recursive: true });
  await fs.writeFile(target, DESKTOP_ENTRY.replaceAll('${EXEC}', exec));
  return target;
}

const CONFLICT_PATHS = [
  '~/Documents/notes.md',
  '~/Projects/budget.ods',
  '~/Photos/IMG_0042.jpg',
];

/**
 * The world, behind an interface: a backup run that makes progress over time
 * and turns up conflicts on the way.
 *
 * `subscribe(cb)` reports `{ type: 'progress' | 'conflict' | 'finished' }`;
 * `start()` begins a run, `pause()`/`resume()` hold it, and `step()` advances
 * exactly one file — which is what the timer calls, and what a test calls
 * instead when `tickMs` is `0`.
 */
export function fixtureBackup({
  total = 14,
  tickMs = 450,
  conflictsAt = [4, 9],
} = {}) {
  const listeners = new Set();
  let done = 0;
  let timer = null;
  const emit = (event) => {
    for (const cb of [...listeners]) cb(event);
  };
  const halt = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  const step = () => {
    if (done >= total) return;
    done += 1;
    emit({ type: 'progress', done, total });
    const nth = conflictsAt.indexOf(done);
    if (nth !== -1) {
      emit({
        type: 'conflict',
        path: CONFLICT_PATHS[nth % CONFLICT_PATHS.length],
      });
    }
    if (done >= total) {
      halt();
      emit({ type: 'finished', total });
    }
  };
  const run = () => {
    halt();
    if (tickMs) timer = setInterval(step, tickMs);
  };
  return {
    tickMs,
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    start() {
      done = 0;
      emit({ type: 'progress', done: 0, total });
      run();
    },
    resume: run,
    pause: halt,
    step,
    stop: halt,
  };
}

// ---------------------------------------------------------------------------
// Icons: the one thing in this family that is genuinely two vocabularies.
//
// Everything else an app asks about is a *feature* — `features.scroll`,
// `features.attention` — and reads the same on every backend. An icon name
// does not: the cocoa rung resolves SF Symbols and a freedesktop one resolves
// names out of the desktop's icon theme, and neither knows the other's
// spelling. (Bytes are the third way — `icon` also takes a PNG — and the way
// to ship one picture to both.)
// ---------------------------------------------------------------------------

const ICONS = {
  cocoa: {
    idle: 'externaldrive.fill',
    running: 'arrow.triangle.2.circlepath',
    attention: 'exclamationmark.triangle.fill',
    overlay: null, // a status item has no overlay badge
  },
  freedesktop: {
    idle: 'drive-harddisk',
    running: 'view-refresh',
    attention: 'dialog-warning',
    overlay: 'emblem-synchronizing',
  },
};

const SURFACE = '#191b22';
const CARD = '#252833';
const CARD_HOVER = '#2f3341';
const INK = '#e8eaf0';
const DIM = '#98a0b4';
const FAINT = '#5d6478';
const ACCENT = '#5c6bc0';
const WARN = '#e5a33d';
const GOOD = '#48b47a';
const BAD = '#b3697a';

/** A local press target — the examples do not import `@react-x11/components`. */
function Button({ label, onPress, tone = 'plain', disabled = false }) {
  return (
    <box
      onClick={disabled ? undefined : onPress}
      style={{
        paddingTop: 6,
        paddingBottom: 6,
        paddingLeft: 12,
        paddingRight: 12,
        borderRadius: 6,
        backgroundColor: tone === 'accent' ? ACCENT : CARD,
        cursor: disabled ? 'default' : 'pointer',
        alignItems: 'center',
        justifyContent: 'center',
        ':hover': disabled
          ? {}
          : { backgroundColor: tone === 'accent' ? '#6b7ad0' : CARD_HOVER },
        ':active': disabled
          ? {}
          : { backgroundColor: tone === 'accent' ? '#4d5ab0' : '#3a3e4d' },
      }}
    >
      <text style={{ color: disabled ? FAINT : INK, fontSize: 13 }}>
        {label}
      </text>
    </box>
  );
}

/** A setting whose *enabled* state is a prediction about the desktop. */
function Check({ label, checked, onToggle, enabled, why }) {
  return (
    <box
      onClick={enabled ? onToggle : undefined}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        cursor: enabled ? 'pointer' : 'default',
      }}
    >
      <box
        style={{
          width: 14,
          height: 14,
          borderRadius: 3,
          backgroundColor: !enabled ? '#2b2e3a' : checked ? ACCENT : CARD_HOVER,
        }}
      />
      <text style={{ color: enabled ? INK : FAINT, fontSize: 13 }}>
        {label}
      </text>
      <text hidden={enabled} style={{ color: FAINT, fontSize: 11 }}>
        {why}
      </text>
    </box>
  );
}

function Bar({ value, tone = ACCENT }) {
  const pct = Math.max(0, Math.min(1, value || 0));
  return (
    <box
      style={{
        height: 6,
        borderRadius: 3,
        backgroundColor: '#2b2e3a',
        flexDirection: 'row',
      }}
    >
      <box
        style={{
          width: `${Math.round(pct * 100)}%`,
          borderRadius: 3,
          backgroundColor: tone,
        }}
      />
    </box>
  );
}

// ---------------------------------------------------------------------------
// The second pane: one card per capability, straight off
// `useDesktopCapability`. This is the pre-flight question — none of these
// probes puts an icon anywhere or posts anything.
// ---------------------------------------------------------------------------

/**
 * The launcher's other half: is there a `.desktop` file for the entry to
 * attach to?
 *
 * Worth its own row because it is the only "everything says yes and nothing
 * appears" state on this pane. `desktopCapability('launcher')` reports
 * `available: true` and `setLauncherMenu()` resolves `true`, both correctly —
 * the signal really was delivered — and the dock still shows nothing, because
 * no icon claims that id. Guessing at it from inside the capability probe
 * would be wrong (the file may live in any XDG data dir, and a launcher may
 * key off something else entirely), so it is surfaced rather than folded in.
 */
function DesktopEntryRow() {
  const [state, setState] = React.useState(null);
  React.useEffect(() => {
    let alive = true;
    void desktopEntryInstalled().then((ok) => alive && setState(ok));
    return () => {
      alive = false;
    };
  }, []);

  if (state === null) return null;
  return (
    <box
      style={{ gap: 4, padding: 10, borderRadius: 8, backgroundColor: CARD }}
    >
      <box style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <box
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: state ? GOOD : FAINT,
          }}
        />
        <text style={{ color: INK, fontSize: 13, flexGrow: 1 }}>
          desktop entry
        </text>
        <text style={{ color: DIM, fontSize: 12 }}>
          {state ? 'installed' : 'missing'}
        </text>
      </box>
      <text style={{ color: FAINT, fontSize: 11 }}>
        {state
          ? `${APP_ID}.desktop — the badge and the right-click menu have an icon to attach to`
          : 'no icon claims this app id, so the badge and quicklist go nowhere. run with --install-desktop-entry'}
      </text>
    </box>
  );
}

function CapabilityCard({ name }) {
  const cap = useDesktopCapability(name);
  const keys = Object.keys(cap.features);

  return (
    <box
      style={{ gap: 6, padding: 10, borderRadius: 8, backgroundColor: CARD }}
    >
      <box style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <box
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: cap.available ? GOOD : FAINT,
          }}
        />
        <text style={{ color: INK, fontSize: 13, flexGrow: 1 }}>{name}</text>
        {/* `backend` names the mechanism and never the platform, which makes
            it the right thing for a diagnostics line like this one and the
            wrong thing to branch on. */}
        <text style={{ color: DIM, fontSize: 12 }}>
          {cap.backend ?? (cap.reason ? cap.reason : '—')}
        </text>
      </box>

      {keys.length === 0 ? (
        <text style={{ color: FAINT, fontSize: 11 }}>
          {cap.reason === 'no-app-id'
            ? 'needs registerApplication({ appId }) — a launcher has nothing to pin an entry to'
            : cap.reason === 'not-primary'
              ? 'another copy of this app owns the identity — the first one has the badge'
              : 'nothing here, or still asking: the first frame never has an answer'}
        </text>
      ) : (
        <box style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {keys.map((key) => (
            <box
              key={key}
              style={{
                paddingTop: 1,
                paddingBottom: 1,
                paddingLeft: 6,
                paddingRight: 6,
                borderRadius: 4,
                backgroundColor: cap.features[key] ? '#25382f' : '#33262b',
              }}
            >
              <text
                style={{ color: cap.features[key] ? GOOD : BAD, fontSize: 11 }}
              >
                {`${cap.features[key] ? '✓' : '✗'} ${key}`}
              </text>
            </box>
          ))}
        </box>
      )}
    </box>
  );
}

// ---------------------------------------------------------------------------

function Backup({ source, onQuit }) {
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [phase, setPhase] = useState('idle'); // idle | running | paused
  const [conflicts, setConflicts] = useState([]);
  const [lastRun, setLastRun] = useState(null);
  const [showTray, setShowTray] = useState(true);
  const [clickOpensWindow, setClickOpensWindow] = useState(false);
  const [lastClick, setLastClick] = useState(null);
  const [bannerNote, setBannerNote] = useState(null);
  const [limit, setLimit] = useState(5); // MB/s, moved by scrolling the tray

  // What a tray *would* do, asked without creating one. The settings rows
  // below are the reason this hook exists: `useTray()` cannot answer them,
  // because asking it means putting the icon there.
  const trayCap = useDesktopCapability('tray');
  const notifications = useDesktopCapability('notifications');
  const notifier = useNotifier();

  // ------------------------------------------------------------- the run
  const finished = useRef(null);
  useEffect(
    () =>
      source.subscribe((event) => {
        if (event.type === 'progress') {
          setDone(event.done);
          setTotal(event.total);
          // Whether a run is happening is the world's fact, not the button's:
          // "Copy one file" and a run started from the tray menu have to put
          // the app in the same state, or the icon and the window disagree.
          if (event.done > 0) setPhase((p) => (p === 'idle' ? 'running' : p));
        } else if (event.type === 'conflict') {
          setConflicts((list) =>
            list.includes(event.path) ? list : [...list, event.path],
          );
        } else if (event.type === 'finished') {
          setPhase('idle');
          setLastRun(event.total);
          finished.current?.(event.total);
        }
      }),
    [source],
  );

  const start = useCallback(() => {
    setConflicts([]);
    setLastRun(null);
    setPhase('running');
    source.start();
  }, [source]);

  const pause = useCallback(() => {
    setPhase('paused');
    source.pause();
  }, [source]);

  const resume = useCallback(() => {
    setPhase('running');
    source.resume();
  }, [source]);

  const resolve = useCallback(
    (path) => setConflicts((list) => list.filter((p) => p !== path)),
    [],
  );

  // -------------------------------------------------- the launcher's icon
  //
  // Three marks on one icon, each its own hook, each cleared on unmount.
  // `progress` is Linux-only (`NSDockTile` has no bar) and the badge is a
  // count on both; neither needs a branch here, because a rung with no
  // mechanism is inert rather than an error.
  useBadge(conflicts.length);
  useProgress(phase === 'running' && total ? done / total : null);

  // Urgency is the one with no hook — it is a fact about the *app*, not
  // about a component — so it is an effect, and it goes off the moment the
  // last conflict is resolved.
  useEffect(() => {
    setUrgent(conflicts.length > 0).catch(() => {});
  }, [conflicts.length]);

  // ----------------------------------------------------------- the menus
  //
  // One `items` array, two places: the tray's menu and the launcher's
  // quicklist (and in a bigger app, the window's own menu bar). That the
  // three are one authoring model is the point — on Linux all three are
  // `com.canonical.dbusmenu` underneath.
  const actions = useMemo(
    () => [
      {
        label:
          phase === 'running'
            ? 'Pause backup'
            : phase === 'paused'
              ? 'Resume backup'
              : 'Back up now',
        onSelect: () =>
          phase === 'running'
            ? pause()
            : phase === 'paused'
              ? resume()
              : start(),
      },
      { type: 'separator' },
      {
        label: conflicts.length
          ? `Keep mine for ${conflicts.length} file${conflicts.length === 1 ? '' : 's'}`
          : 'Nothing needs you',
        enabled: conflicts.length > 0,
        onSelect: () => setConflicts([]),
      },
    ],
    [phase, conflicts.length, pause, resume, start],
  );

  useLauncherMenu(actions);

  // ------------------------------------------------------------ the tray
  const app = useApp();
  // See the ICONS note: the one branch in this file about the mechanism
  // rather than about a feature.
  const icons =
    typeof app?.createStatusItem === 'function'
      ? ICONS.cocoa
      : ICONS.freedesktop;

  const state = conflicts.length
    ? 'attention'
    : phase === 'idle'
      ? 'idle'
      : 'running';

  const trayMenu = useMemo(
    () => [
      ...actions,
      { type: 'separator' },
      { label: 'Quit', onSelect: onQuit },
    ],
    [actions, onQuit],
  );

  const tray = useTray(
    showTray
      ? {
          icon: icons[state],
          // Shown instead of `icon` while `attention` is set; `overlayIcon`
          // is the corner badge. Freedesktop only, both — `features.attention`
          // and `features.overlay` say so, and passing them on a rung with
          // neither costs nothing.
          attentionIcon: icons.attention,
          overlayIcon: phase === 'running' ? icons.overlay : null,
          attention: conflicts.length > 0,
          // Where a panel sorts the icon. A backup agent is a service.
          category: 'SystemServices',
          title:
            phase === 'running' && total
              ? `${Math.round((done / total) * 100)}%`
              : null,
          tooltip: conflicts.length
            ? `Backup — ${conflicts.length} need you`
            : phase === 'idle'
              ? lastRun
                ? `Backup — ${lastRun} files, done`
                : 'Backup — idle'
              : `Backup — ${done} of ${total}`,
          // A menu and `onClick` are alternatives, not a pair: with a menu a
          // click opens it and `onClick` never fires. Both are real app
          // choices, so the setting below switches between them.
          menu: clickOpensWindow ? null : trayMenu,
          onClick: clickOpensWindow ? setLastClick : undefined,
          // Freedesktop only. On a rung without it the callback is simply
          // never called, which is why the row below is dimmed by
          // `features.scroll` rather than being live and inert.
          onScroll: ({ delta }) =>
            setLimit((mb) =>
              Math.max(1, Math.min(50, mb + (delta > 0 ? -1 : 1))),
            ),
        }
      : null,
  );

  // ---------------------------------------------------- the notification
  //
  // What to post is a question about `features`, not about the platform: a
  // daemon that does not advertise `actions` shows the buttons nowhere and
  // reports nothing back, so an app that posts them anyway has written its
  // user a dead end. Ask, then post the shape that will work.
  finished.current = useCallback(
    (count) => {
      if (!notifier.available) return;
      notifier
        .notify({
          summary: 'Backup finished',
          body: `${count} files copied`,
          icon: icons.idle,
          category: 'transfer.complete',
          actions: notifications.features.actions
            ? [{ key: 'show', label: 'Show files' }]
            : undefined,
          // Both of these fire only where `features.events` does. On a rung
          // without them the banner still shows and nothing is ever reported
          // back, which is why offering the button there would be a dead end.
          onAction: (key) => setBannerNote(`you pressed ${key}`),
          onClose: (reason) => setBannerNote(`banner ${reason}`),
        })
        .catch(() => {});
    },
    [notifier, notifications.features.actions, icons.idle],
  );

  // ------------------------------------------------------------------ UI
  const trayNote = tray.error
    ? `a tray answered and refused — ${tray.error.message}`
    : tray.available
      ? `icon live on ${tray.backend}`
      : showTray
        ? 'no tray took the icon; the window is the whole app'
        : 'turned off';

  return (
    <window
      width={560}
      height={640}
      minWidth={460}
      minHeight={460}
      title={conflicts.length ? `Backup (${conflicts.length})` : 'Backup'}
      // X11: matched against the entry's `StartupWMClass=`.
      appId={APP_ID}
      // Wayland: the xdg `app_id`, matched against the entry's file name.
      appId={APP_ID}
      style={{ backgroundColor: SURFACE }}
    >
      <box style={{ flexGrow: 1, padding: 16, gap: 12 }}>
        <box style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <text style={{ color: INK, fontSize: 20, flexGrow: 1 }}>Backup</text>
          <text style={{ color: DIM, fontSize: 12 }}>
            {phase === 'idle'
              ? lastRun
                ? `last run: ${lastRun} files`
                : 'idle'
              : `${done} of ${total}`}
          </text>
        </box>

        <Bar
          value={total ? done / total : 0}
          tone={conflicts.length ? WARN : ACCENT}
        />

        <box style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <Button
            label={
              phase === 'running'
                ? 'Pause'
                : phase === 'paused'
                  ? 'Resume'
                  : 'Back up now'
            }
            tone="accent"
            onPress={
              phase === 'running' ? pause : phase === 'paused' ? resume : start
            }
          />
          <Button label="Copy one file" onPress={() => source.step()} />
          <box style={{ flexGrow: 1 }} />
          <text style={{ color: DIM, fontSize: 12 }}>{`${limit} MB/s`}</text>
        </box>

        {/* The conflicts: the badge's count, the urgency's reason and the
            tray's attention icon are all this one list. */}
        <box style={{ gap: 6 }}>
          <text style={{ color: conflicts.length ? WARN : DIM, fontSize: 13 }}>
            {conflicts.length
              ? `${conflicts.length} file${conflicts.length === 1 ? '' : 's'} changed on both sides`
              : 'Nothing needs you'}
          </text>
          {conflicts.map((path) => (
            <box
              key={path}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
                paddingTop: 6,
                paddingBottom: 6,
                paddingLeft: 10,
                paddingRight: 10,
                borderRadius: 6,
                backgroundColor: CARD,
              }}
            >
              <text style={{ color: INK, fontSize: 12, flexGrow: 1 }}>
                {path}
              </text>
              <Button label="Keep mine" onPress={() => resolve(path)} />
            </box>
          ))}
        </box>

        {/* ------------------------------------------------ This desktop */}
        <text style={{ color: INK, fontSize: 16 }}>This desktop</text>

        <box style={{ gap: 8, flexGrow: 1, overflow: 'scroll' }}>
          {CAPABILITIES.map((name) => (
            <CapabilityCard key={name} name={name} />
          ))}

          <DesktopEntryRow />

          <box
            style={{
              gap: 8,
              padding: 10,
              borderRadius: 8,
              backgroundColor: CARD,
            }}
          >
            <Check
              label="Show tray icon"
              checked={showTray}
              onToggle={() => setShowTray((v) => !v)}
              // The prediction, not the measurement: this row has to be right
              // before any icon exists.
              enabled={trayCap.available}
              why="no tray on this desktop"
            />
            <Check
              label="Clicking the tray icon reports the click instead of opening a menu"
              checked={clickOpensWindow}
              onToggle={() => setClickOpensWindow((v) => !v)}
              enabled={trayCap.features.click === true}
              why="this tray reports no clicks"
            />
            <Check
              label="Scroll the tray icon to change the rate limit"
              checked
              onToggle={() => {}}
              enabled={tray.features.scroll === true}
              why="this tray has no scroll"
            />
            <text style={{ color: DIM, fontSize: 11 }}>
              {lastClick
                ? // Read the flag, never the value: the freedesktop rung sends
                  // a zero rect and all-false modifiers because its protocol
                  // carries neither, and "0" is not "at the origin".
                  `last tray click: ${lastClick.button}` +
                  (tray.features.clickPosition
                    ? ` at ${lastClick.x},${lastClick.y}`
                    : '') +
                  (tray.features.clickRect
                    ? ` · rect ${lastClick.width}×${lastClick.height}`
                    : ' · no rect in this protocol') +
                  (tray.features.clickModifiers
                    ? ` · shift ${lastClick.shift ? 'yes' : 'no'}`
                    : ' · no modifiers in this protocol')
                : clickOpensWindow
                  ? 'click the tray icon — no menu is installed while this is on'
                  : 'the tray icon has a menu; turn the row above on for clicks instead'}
            </text>
          </box>
        </box>

        <text style={{ color: DIM, fontSize: 11 }}>
          {`tray: ${trayNote}`}
          {'  ·  '}
          {`notifications: ${
            notifications.available
              ? `${notifications.backend}${
                  notifications.features.actions
                    ? ' with actions'
                    : ', no actions'
                }`
              : 'none here'
          }`}
          {bannerNote ? `  ·  ${bannerNote}` : ''}
        </text>
      </box>
    </window>
  );
}

export default function App({ source, onQuit = () => {} }) {
  // A source is provided by the test; the app makes its own otherwise, once.
  const own = useMemo(() => source ?? fixtureBackup(), [source]);
  useEffect(() => () => own.stop(), [own]);
  return <Backup source={own} onQuit={onQuit} />;
}

// ---------------------------------------------------------------------------
// Autorun.
//
// `registerApplication()` before `createRoot()` (docs/uri-schemes.md), and it
// earns its place twice here: the launcher rung is attributed by the
// `.desktop` id it establishes, and with no id `desktopCapability('launcher')`
// reports `reason: 'no-app-id'` rather than blaming the desktop. That is the
// one "no" on the whole pane an app author can fix, and the pane says so.
// ---------------------------------------------------------------------------

if (!process.env.REACT_X11_NO_AUTORUN && !import.meta.hot) {
  // `--install-desktop-entry` and exit: the launcher half of this example is
  // an install step, and a flag is more honest than a README line nobody
  // runs. Writing it needs no privileges — it goes under XDG_DATA_HOME.
  if (process.argv.includes('--install-desktop-entry')) {
    const written = await installDesktopEntry();
    console.log(
      `wrote ${written}\n` +
        'the dock may need a moment, or a log out, to notice a new entry.',
    );
    process.exit(0);
  }

  await registerApplication({ appId: APP_ID }).catch(() => {});

  // `desktopCapability()` is the imperative twin, for code with no component
  // — a line in the log before the first frame is exactly its case.
  const summary = await Promise.all(
    CAPABILITIES.map(async (name) => {
      const cap = await desktopCapability(name);
      return `${name}: ${cap.backend ?? cap.reason ?? 'none'}`;
    }),
  );
  console.log(`desktop — ${summary.join(', ')}`);

  const root = await createRoot({
    // The toplevel's xdg `app_id` on Wayland — the same string the launcher
    // entry is attributed to, and the only way the dock can tell that this
    // window is the app the badge belongs to. `<window appId>` below is its
    // X11 counterpart.
    appId: APP_ID,
    cocoa: { appName: 'Backup', activationPolicy: 'regular' },
  });

  const quit = () => {
    // The marks on the launcher icon outlive the tree unless something takes
    // them down: the hooks' own cleanup runs on unmount, so a quit path that
    // exits first leaves a badge behind. Hence the imperative twins — and
    // clearing the last of them also releases the bus reference the entry was
    // holding, which is what lets the process exit at all.
    void Promise.all([
      setBadge(null),
      setProgress(null),
      setLauncherMenu(null),
      setUrgent(false),
    ])
      .catch(() => {})
      .then(() => root.unmount())
      .then(
        () => process.exit(0),
        () => process.exit(1),
      );
  };

  root.render(<App onQuit={quit} />);
}

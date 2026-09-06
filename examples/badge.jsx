// An inbox — the part of an application that lives on the icon, not in the
// window.
//
//   npm run examples:badge                         # X11 / XQuartz
//   REACT_X11_BACKEND=cocoa npm run examples:badge  # a real macOS app
//
// The other examples are about what happens inside the window. This one is
// about what an app says to the launcher while nobody is looking at it: an
// unread **count on its icon**, a **bounce** for attention when a message
// arrives and the window is not focused, a **Dock menu** of quick actions,
// and the **name and dock behaviour** it launches with. Every one of those is
// a thing a user notices when it is missing and never thinks about when it is
// there, and every one degrades to nothing on a machine that cannot do it —
// which is most of them, so the footer says which are live.
//
// ## What to try
//
//   Let it sit      messages arrive on a timer. The badge counts the unread
//                   ones; on the cocoa backend it is the Dock tile's number,
//                   on a KDE / elementary / Cairo-Dock desktop it is the
//                   launcher's (through `com.canonical.Unity.LauncherEntry`,
//                   which needs the `.desktop` id `registerApplication`
//                   establishes — so on X11 the count only shows where such a
//                   launcher is listening; GNOME needs an extension).
//
//   Click away      to another window, then wait for a message. The icon
//                   **bounces** (cocoa) or the taskbar entry goes **urgent**
//                   (X11) — `states={['demands_attention']}`, set only while
//                   the window is unfocused, because attention you asked for
//                   while the user was already looking is attention misspent.
//                   Come back and it stops.
//
//   Read one        click a message: the badge drops. "Mark all read" clears
//                   it. The badge is `useBadge(unread)` — a number, cleared
//                   when it reaches zero and on unmount.
//
//   Right-click     the Dock icon (cocoa only): "Mark all read" and "New
//                   message" are there too, from the same `items` array
//                   `MenuBar` takes. Off cocoa the hook is inert and the
//                   footer says so.
//
// ## The seam
//
// `fixtureInbox()` is where the messages come from — a timer and a bag of
// senders and subjects. It is a seam on purpose (AGENTS.md, "put a seam where
// the world is"): a real inbox would poll IMAP or hold a socket here, and
// `test/badge-example.test.js` drives this same app through one with the
// clock turned all the way down. The rest of the file never learns which.
//
// A note on what is *not* here: an in-app toast or a message pane. This app
// is deliberately only the outward half — the list is the minimum needed to
// have something to count.
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  createRoot,
  registerApplication,
  useApp,
  useBadge,
  useDockMenu,
  useWindowState,
} from '../src/index.js';

const APP_ID = 'com.example.x11inbox';

const SENDERS = [
  'Ada Lovelace',
  'Grace Hopper',
  'Alan Kay',
  'Radia Perlman',
  'Barbara Liskov',
];
const SUBJECTS = [
  'Re: the layout engine',
  'Lunch?',
  'Your package shipped',
  'Build is green',
  'One quick question',
  'Notes from the review',
];

/**
 * The world, behind an interface: a source of messages that arrive over time.
 * `subscribe(cb)` calls `cb(message)` for each new one and returns an
 * unsubscribe; `simulate()` produces one on demand (the Dock menu and the
 * button use it). `interval: 0` never fires on its own — the shape the test
 * uses, driving arrivals by hand.
 */
export function fixtureInbox({ interval = 9000, now = Date.now } = {}) {
  let seq = 0;
  const listeners = new Set();
  const make = () => ({
    id: ++seq,
    from: SENDERS[seq % SENDERS.length],
    subject: SUBJECTS[seq % SUBJECTS.length],
    at: now(),
    read: false,
  });
  const emit = () => {
    const message = make();
    for (const cb of [...listeners]) cb(message);
    return message;
  };
  return {
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    simulate: emit,
    interval,
  };
}

const SURFACE = '#20222b';
const CARD = '#2b2e3a';
const CARD_HOVER = '#343848';
const INK = '#e8eaf0';
const DIM = '#9aa0b4';
const ACCENT = '#5c6bc0';

/** A local press target — the examples do not import `@react-x11/components`,
 * so a button is a `<box>` with the press feedback drawn as state blocks
 * (AGENTS.md, "answer the input, not the outcome"). */
function Button({ label, onPress, tone = 'plain' }) {
  return (
    <box
      onClick={onPress}
      style={{
        paddingTop: 6,
        paddingBottom: 6,
        paddingLeft: 12,
        paddingRight: 12,
        borderRadius: 6,
        backgroundColor: tone === 'accent' ? ACCENT : CARD,
        cursor: 'pointer',
        alignItems: 'center',
        justifyContent: 'center',
        ':hover': {
          backgroundColor: tone === 'accent' ? '#6b7ad0' : CARD_HOVER,
        },
        ':active': {
          backgroundColor: tone === 'accent' ? '#4d5ab0' : '#3d4152',
        },
      }}
    >
      <text style={{ color: INK, fontSize: 13 }}>{label}</text>
    </box>
  );
}

function Row({ message, onRead }) {
  return (
    <box
      onClick={() => !message.read && onRead(message.id)}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingTop: 8,
        paddingBottom: 8,
        paddingLeft: 12,
        paddingRight: 12,
        borderRadius: 6,
        backgroundColor: CARD,
        cursor: message.read ? 'default' : 'pointer',
        ':hover': message.read ? {} : { backgroundColor: CARD_HOVER },
      }}
    >
      <box
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          backgroundColor: message.read ? 'transparent' : ACCENT,
        }}
      />
      <box style={{ flexGrow: 1, gap: 2 }}>
        <text
          style={{
            color: message.read ? DIM : INK,
            fontSize: 14,
          }}
        >
          {message.subject}
        </text>
        <text style={{ color: DIM, fontSize: 12 }}>{message.from}</text>
      </box>
    </box>
  );
}

function Inbox({ source }) {
  const [messages, setMessages] = useState([]);
  const { focused } = useWindowState();

  // New messages arrive from the seam. A message that lands while the window
  // is not focused should ask for attention; `focusedRef` is read in the
  // subscription so it sees the *current* focus, not the render that armed it.
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const [wantsAttention, setWantsAttention] = useState(false);

  const add = useCallback((message) => {
    setMessages((list) => [message, ...list].slice(0, 50));
    if (!focusedRef.current) setWantsAttention(true);
  }, []);

  useEffect(() => source.subscribe(add), [source, add]);

  useEffect(() => {
    if (!source.interval) return undefined;
    const id = setInterval(() => source.simulate(), source.interval);
    return () => clearInterval(id);
  }, [source]);

  // Attention is answered the moment the user looks: coming back to the
  // window clears it, which is the whole point of only having asked while
  // they were away.
  useEffect(() => {
    if (focused) setWantsAttention(false);
  }, [focused]);

  const unread = useMemo(
    () => messages.filter((m) => !m.read).length,
    [messages],
  );

  const markRead = useCallback(
    (id) =>
      setMessages((list) =>
        list.map((m) => (m.id === id ? { ...m, read: true } : m)),
      ),
    [],
  );
  const markAllRead = useCallback(
    () => setMessages((list) => list.map((m) => ({ ...m, read: true }))),
    [],
  );

  // The badge: the unread count on the icon. A number on both backends; it
  // clears itself at zero.
  useBadge(unread);

  // The Dock menu: the same actions, reachable without the window. `items`
  // is `MenuBar`'s vocabulary; inert off the cocoa backend.
  const dockMenu = useMemo(
    () => [
      { label: 'Mark all read', onSelect: markAllRead },
      { type: 'separator' },
      { label: 'New message', onSelect: () => source.simulate() },
    ],
    [markAllRead, source],
  );
  useDockMenu(dockMenu);

  // What this machine can actually do, for the footer — read off the app the
  // tree renders through, the way `useSupports` reads a capability.
  const app = useApp();
  const dockMenuLive = typeof app?.setDockMenu === 'function';

  return (
    <window
      width={420}
      height={520}
      title={unread ? `Inbox (${unread})` : 'Inbox'}
      minWidth={340}
      minHeight={320}
      wmClass={APP_ID}
      states={wantsAttention ? ['demands_attention'] : []}
      style={{ backgroundColor: SURFACE }}
    >
      <box style={{ flexGrow: 1, padding: 16, gap: 12 }}>
        <box
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <text style={{ color: INK, fontSize: 20, flexGrow: 1 }}>Inbox</text>
          <box
            hidden={unread === 0}
            style={{
              paddingTop: 2,
              paddingBottom: 2,
              paddingLeft: 8,
              paddingRight: 8,
              borderRadius: 10,
              backgroundColor: ACCENT,
            }}
          >
            <text
              style={{ color: '#fff', fontSize: 12 }}
            >{`${unread} unread`}</text>
          </box>
        </box>

        <box style={{ flexDirection: 'row', gap: 8 }}>
          <Button
            label="New message"
            tone="accent"
            onPress={() => source.simulate()}
          />
          <Button label="Mark all read" onPress={markAllRead} />
        </box>

        <box
          style={{
            flexGrow: 1,
            gap: 6,
            overflow: 'scroll',
          }}
        >
          {messages.length === 0 ? (
            <text style={{ color: DIM, fontSize: 13 }}>
              No messages yet. One arrives every few seconds — or press “New
              message”. Click away and wait for one to see the icon ask for you.
            </text>
          ) : (
            messages.map((m) => (
              <Row key={m.id} message={m} onRead={markRead} />
            ))
          )}
        </box>

        <text style={{ color: DIM, fontSize: 11 }}>
          {focused ? 'focused' : 'not focused — a new message will ask for you'}
          {'  ·  '}
          Dock menu:{' '}
          {dockMenuLive ? 'active (right-click the icon)' : 'inert here'}
        </text>
      </box>
    </window>
  );
}

export default function App({ source }) {
  // A source is provided by the test; the app makes its own otherwise, once.
  const own = useMemo(() => source ?? fixtureInbox(), [source]);
  return <Inbox source={own} />;
}

// ---------------------------------------------------------------------------
// Autorun. `registerApplication()` before `createRoot()` (docs/uri-schemes.md)
// — and here it earns its place twice: the badge on Linux is attributed to
// the app by the `.desktop` id it establishes, so without it the launcher has
// nothing to pin the count to. `activationPolicy`/`appName` are cocoa options
// that decide how the app appears in the Dock and ⌘-Tab; ignored elsewhere.
// ---------------------------------------------------------------------------

if (!process.env.REACT_X11_NO_AUTORUN && !import.meta.hot) {
  await registerApplication({ appId: APP_ID }).catch(() => {});

  const root = await createRoot({
    cocoa: { appName: 'Inbox', activationPolicy: 'regular' },
  });
  root.render(<App />);
}

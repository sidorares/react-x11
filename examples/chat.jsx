// A chat client, and the app React's concurrent features were designed for.
//
//   npm run examples:chat                       # a bundled fake server
//
//   # a real network. Name the channels: the three this demo uses by default
//   # are real ones, and joining them because an example said so is rude.
//   CHAT_IRC=irc.libera.chat \
//     npm run examples:chat -- --nick=yourname --channels='#somewhere'
//
// Nothing here is a panel with a switch on it: every React feature below is
// load-bearing, doing the job it exists for, and the way to see one working
// is to use the app rather than to toggle it.
//
// ## What to look for
//
//   Activity    Type half a message in #general, scroll up a few lines, and
//               switch to #x11. Come back. The draft is still there and the
//               scrollback is where you left it — every channel stays
//               mounted in an <Activity mode="hidden">, so nothing is
//               remembered by hand. Then notice what does *not* happen while
//               you are away: keys typed in #x11 never reach #general's
//               composer, because focus follows visibility (#202/#323).
//
//   Optimistic  Your message appears the instant you press Enter, dimmed,
//               with the tick still missing. That is `useOptimistic`, and it
//               is not a copy of the message kept in a second list — turn on
//               "drop the next send" and watch the line vanish again when
//               the send fails. Rollback is not code in this file.
//
//   Suspense    The first visit to a channel loads its history. `use()` on a
//               cached promise, one boundary per pane, with a fallback that
//               is the size of the thing it replaces — a fallback that lays
//               out smaller makes the window jump twice.
//
//   Boundary    "break the pane" throws inside a channel's render. One pane
//               goes to its error state; the sidebar, the other channels and
//               the connection all keep working, which is the whole reason
//               the boundary is *inside* the window rather than around it.
//
// ## The transport is a seam, and that is the interesting part
//
// `fixtureTransport()` is a fake server: bots talk on a timer, sends take a
// while, and a switch makes them fail. It runs offline, it is deterministic
// enough to test against, and `test/chat.test.js` drives this same app
// through one with the timers turned all the way down.
//
// `ircTransport()` is the real thing — IRC is a line protocol you can hold in
// your head, which is why it is the one here. Same interface, and the
// difference between them is the point: connect to a real server and the
// channels open **empty**, because IRC has no scrollback. `history()` is on
// the transport for exactly that reason. It was not, once, and a real session
// opened with the fake's bots discussing CRTs — which is the failure mode a
// seam exists to prevent, arrived at by leaving one method out of it.
//
// `--channels` and `CHAT_CHANNELS` pick what to join; `CHAT_IRC_PORT`
// defaults to 6667.
//
// A disconnect is *not* a react-x11 disconnect. If the X server goes away,
// nothing in this file helps: every window id and pixmap dies with the
// connection and the root has to be rebuilt (see `docs/README.md`). This
// banner is about the chat server, which is an ordinary socket and an
// ordinary retry.
import net from 'node:net';

import React, {
  Activity,
  Suspense,
  use,
  useCallback,
  useEffect,
  useMemo,
  useOptimistic,
  useRef,
  useState,
  useTransition,
} from 'react';

import { Button, Switch, createRoot, createStyles } from '../src/index.js';

const CHANNELS = ['#general', '#x11', '#react'];

// ---------------------------------------------------------------------------
// The transport seam
//
// Four methods. `send` returns the delivered message or throws — the promise
// is what `useOptimistic` hangs the pending state on, so a transport that
// resolved immediately would make the feature invisible rather than fast.
// ---------------------------------------------------------------------------

let nextId = 1;
const messageId = () => `m${nextId++}`;

const BOT_LINES = {
  '#general': [
    ['ada', 'morning'],
    ['grace', 'anyone else on a 1600x1200 CRT today'],
    ['ada', 'the good ones were 2048x1536'],
    ['linus', 'mine does 85Hz and I will not be taking questions'],
  ],
  '#x11': [
    ['keith', 'RENDER is 25 years old this year'],
    ['jim', 'and still the fastest way to put a trapezoid on a screen'],
    ['keith', 'the trick was never asking the server to think'],
  ],
  '#react': [
    ['dan', 'a renderer is just a host config and some opinions'],
    ['seb', 'the opinions are the hard part'],
  ],
};

/**
 * A fake server. Bots post on a timer, sends take `latency` ms, and
 * `state.failNext` makes the next one throw — which is the only way to see an
 * optimistic message roll back.
 *
 * `hold: true` parks every send instead of timing it, until `flush()` lets
 * them go. That exists for the tests and is worth having in the example
 * rather than beside it: an optimistic entry only exists between the send and
 * its answer, so a test that asserts on that state is racing a timer, and on
 * a loaded CI runner it loses. A fake server you can pause has no window to
 * miss. It is also the honest shape for a fake — real latency is not a
 * constant, and pretending otherwise is what makes a test flaky at 3am.
 */
export function fixtureTransport({
  latency = 450,
  botEvery = 6000,
  historyDelay = 600,
  hold = false,
} = {}) {
  const listeners = new Set();
  const statusListeners = new Set();
  const held = [];
  let timer = null;
  let turn = 0;
  let status = 'offline';
  const state = { failNext: false };

  const emit = (msg) => listeners.forEach((fn) => fn(msg));
  const setStatus = (next) => {
    status = next;
    statusListeners.forEach((fn) => fn(next));
  };

  return {
    state,
    channels: CHANNELS,
    get status() {
      return status;
    },
    connect() {
      setStatus('connecting');
      setTimeout(() => setStatus('online'), Math.min(latency, 300));
      if (botEvery > 0 && timer === null) {
        timer = setInterval(() => {
          const channel = CHANNELS[turn % CHANNELS.length];
          const lines = BOT_LINES[channel];
          const [from, text] = lines[turn % lines.length];
          turn += 1;
          emit({ id: messageId(), channel, from, text, at: Date.now() });
        }, botEvery);
        timer.unref?.();
      }
    },
    async send(channel, text, from) {
      await (hold
        ? new Promise((resolve) => held.push(resolve))
        : new Promise((resolve) => setTimeout(resolve, latency)));
      if (state.failNext) {
        state.failNext = false;
        throw new Error('the server dropped it');
      }
      return { id: messageId(), channel, from, text, at: Date.now() };
    },
    /** The scrollback this fake pretends was already there. */
    history(channel) {
      return new Promise((resolve) =>
        setTimeout(
          () =>
            resolve(
              (BOT_LINES[channel] ?? []).map(([from, text], i) => ({
                id: `h${channel}${i}`,
                channel,
                from,
                text,
                at: Date.now() - (10 - i) * 60000,
                history: true,
              })),
            ),
          historyDelay,
        ),
      );
    },
    /** Let every held send finish. Only meaningful with `hold: true`. */
    flush() {
      held.splice(0).forEach((resolve) => resolve());
    },
    onMessage(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    onStatus(fn) {
      statusListeners.add(fn);
      return () => statusListeners.delete(fn);
    },
    close() {
      if (timer !== null) clearInterval(timer);
      timer = null;
      setStatus('offline');
    },
  };
}

/**
 * Real IRC. The whole client is: announce yourself, join, answer PING, and
 * treat every PRIVMSG as a line. Sends are fire-and-forget on the wire — IRC
 * has no per-message acknowledgement — so `send` resolves when the socket has
 * flushed, which is the honest moment and still late enough to be visible.
 */
export function ircTransport({
  host,
  port = 6667,
  nick = `rx11${Math.floor(Math.random() * 900 + 100)}`,
  channels = CHANNELS,
} = {}) {
  const listeners = new Set();
  const statusListeners = new Set();
  let socket = null;
  let status = 'offline';
  let buffer = '';

  const emit = (msg) => listeners.forEach((fn) => fn(msg));
  const setStatus = (next) => {
    status = next;
    statusListeners.forEach((fn) => fn(next));
  };

  const line = (text) => socket?.write(`${text}\r\n`);

  // A join can be refused, and the refusal arrives as a numeric rather than
  // as anything resembling a message. Swallow it and the pane simply stays
  // empty for ever, which is indistinguishable from a quiet channel — the
  // reading is "this example is broken". `+r` is the common one: plenty of
  // channels require a registered nick, and a fresh nick is not one.
  const JOIN_REFUSED = {
    471: 'the channel is full',
    473: 'invite only',
    474: 'you are banned',
    475: 'the channel needs a key',
    477: 'the channel needs a registered nick — /msg NickServ, or pick another',
    403: 'no such channel',
  };

  const handle = (raw) => {
    if (raw.startsWith('PING')) return line(`PONG ${raw.slice(5)}`);

    // :server <code> <nick> #channel :text
    const numeric = /^:\S+ (\d{3}) \S+ (#\S+) :(.*)$/.exec(raw);
    if (numeric) {
      const why = JOIN_REFUSED[Number(numeric[1])];
      if (why) {
        emit({
          id: messageId(),
          channel: numeric[2],
          from: '*',
          text: `could not join — ${why}`,
          at: Date.now(),
          system: true,
        });
      }
      return;
    }

    // :nick!user@host PRIVMSG #channel :text
    const match = /^:([^!]+)![^ ]+ PRIVMSG (#[^ ]+) :(.*)$/.exec(raw);
    if (!match) return;
    const [, from, channel, text] = match;
    emit({ id: messageId(), channel, from, text, at: Date.now() });
  };

  return {
    state: { failNext: false },
    channels,
    get status() {
      return status;
    },
    nick,
    connect() {
      setStatus('connecting');
      socket = net.connect({ host, port }, () => {
        line(`NICK ${nick}`);
        line(`USER ${nick} 0 * :react-x11 chat example`);
        channels.forEach((c) => line(`JOIN ${c}`));
        setStatus('online');
      });
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\r\n');
        buffer = lines.pop() ?? '';
        lines.forEach(handle);
      });
      socket.on('error', () => setStatus('offline'));
      socket.on('close', () => setStatus('offline'));
    },
    async send(channel, text, from) {
      if (!socket || status !== 'online') throw new Error('not connected');
      await new Promise((resolve, reject) =>
        socket.write(`PRIVMSG ${channel} :${text}\r\n`, (err) =>
          err ? reject(err) : resolve(),
        ),
      );
      return { id: messageId(), channel, from, text, at: Date.now() };
    },
    /** IRC has no scrollback. A channel starts empty and fills as people
     *  talk; catching up on what was said before you joined is a bouncer's
     *  job, not the protocol's. Answering `[]` rather than inventing
     *  something is the whole point of this method being on the transport. */
    history() {
      return Promise.resolve([]);
    },
    onMessage(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    onStatus(fn) {
      statusListeners.add(fn);
      return () => statusListeners.delete(fn);
    },
    close() {
      socket?.destroy();
      socket = null;
      setStatus('offline');
    },
  };
}

// ---------------------------------------------------------------------------
// History, for <Suspense>
//
// `use(promise)` needs the *same* promise back on every render for a given
// input, or the component suspends forever on a new one. A module-level cache
// keyed by what identifies the request is the whole trick — the same shape
// examples/react-features.jsx used, and the one thing about Suspense that has
// to be got right before anything else works.
//
// **The scrollback belongs to the transport**, which is not where this
// started: history was a module-level function that returned the fixture's
// lines whatever transport was connected, so a real IRC session still opened
// with `ada` and `grace` talking about CRTs. A fake that leaks into the real
// thing is worse than no fake. `history(channel)` is the fourth method on the
// contract for that reason, and the cache is keyed by transport as well as by
// channel so two of them cannot share an answer.
// ---------------------------------------------------------------------------

const historyCache = new WeakMap();

export function loadHistory(transport, channel) {
  let byChannel = historyCache.get(transport);
  if (!byChannel) historyCache.set(transport, (byChannel = new Map()));
  let promise = byChannel.get(channel);
  if (!promise) byChannel.set(channel, (promise = transport.history(channel)));
  return promise;
}

/** A WeakMap needs no clearing — a transport that goes out of scope takes
 *  its cached history with it, and each test builds a fresh one. Kept as a
 *  no-op so callers do not have to care which it is. */
export function clearHistory() {}

// ---------------------------------------------------------------------------

const s = createStyles({
  root: { flexDirection: 'row', flexGrow: 1 },

  sidebar: {
    width: 168,
    padding: 8,
    gap: 4,
    backgroundColor: '$surfaceHover',
    borderRightWidth: 1,
    borderColor: '$border',
  },
  sidebarHead: {
    fontSize: 11,
    color: '$textMuted',
    paddingStart: 6,
    paddingBottom: 4,
  },
  channel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingStart: 8,
    paddingEnd: 8,
    paddingTop: 6,
    paddingBottom: 6,
    borderRadius: '$radius',
    ':hover': { backgroundColor: '$surfaceHover' },
    // A press state as well as a hover, because the row acts on the release
    // and the press is where the user starts waiting — AGENTS.md, "answer the
    // input, not the outcome".
    ':active': { backgroundColor: '$surfaceActive' },
  },
  // The selected row needs its **own** hover and press. State blocks from the
  // base style still apply once the two are merged, so without these the
  // plain `:hover` paints over the accent and the current channel stops
  // looking current exactly while the pointer is on it. `<Button primary>`
  // carries accentHover/accentActive for the same reason rather than
  // inheriting the surface ones.
  channelOn: {
    backgroundColor: '$accent',
    ':hover': { backgroundColor: '$accentHover' },
    ':active': { backgroundColor: '$accentActive' },
  },
  channelName: { flexGrow: 1, fontSize: 13, color: '$text' },
  channelNameOn: { color: '$accentText' },
  // A pill, not a padded label. Padding round a `<text>` gives it the font's
  // **line box** — which carries the leading, and leaves more room above the
  // digits than below, so the count rides low. On a face with a real line gap
  // that is visible; `sans-serif` on macOS can resolve to one (#86).
  //
  // Two things fix it and both are worth having: a fixed height centred with
  // flex, so the pill does not depend on font metrics at all, and
  // `textBoxTrim` on the label so what gets centred is the digits rather than
  // the line box around them.
  unreadPill: {
    minWidth: 16,
    height: 16,
    paddingStart: 5,
    paddingEnd: 5,
    borderRadius: 8,
    backgroundColor: '$accent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  unread: {
    fontSize: 10,
    color: '$accentText',
    textBoxTrim: 'cap-alphabetic',
  },

  main: { flexGrow: 1 },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingStart: 12,
    paddingEnd: 12,
    paddingTop: 6,
    paddingBottom: 6,
    borderBottomWidth: 1,
    borderColor: '$border',
  },
  bannerText: { flexGrow: 1, fontSize: 12, color: '$textMuted' },
  dot: { width: 8, height: 8, borderRadius: 4 },

  scroll: { flexGrow: 1, overflow: 'scroll', padding: 12, gap: 2 },
  line: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  who: { width: 74, fontSize: 12, color: '$textMuted', textAlign: 'end' },
  what: { flexGrow: 1, fontSize: 13, color: '$text' },
  whatPending: { color: '$textMuted' },
  // A line the client wrote, not a person — a refused join, say. Reads as
  // chrome rather than as something somebody said.
  whatSystem: { color: '$warning', fontStyle: 'italic' },
  tick: { width: 12, fontSize: 11, color: '$success' },
  // Wide enough for the widest thing that goes in it, and told not to wrap:
  // a fixed-width column that can wrap is a row whose height changes with its
  // content, which in a scrollback means the whole list reflows.
  when: { width: 42, fontSize: 11, color: '$textMuted', textWrap: 'nowrap' },

  composer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 10,
    borderTopWidth: 1,
    borderColor: '$border',
  },
  // The palette's own control padding, not a number picked by eye: a field's
  // box is its capitals, so `$paddingY` twice plus the border is the same sum
  // a <Button> is, and the two line up. A hand-picked 6 made this composer
  // 24px tall next to a 36px Send. See docs/styling.md.
  input: {
    flexGrow: 1,
    paddingStart: 10,
    paddingEnd: 10,
    paddingTop: '$paddingY',
    paddingBottom: '$paddingY',
    borderWidth: '$borderWidth',
    borderColor: '$border',
    borderRadius: '$radius',
    ':focus': { borderColor: '$accent' },
  },

  fallback: { flexGrow: 1, padding: 12, gap: 6 },
  ghost: { height: 13, backgroundColor: '$surfaceHover', borderRadius: 3 },
  error: { flexGrow: 1, padding: 16, gap: 10, justifyContent: 'center' },
  errorText: { fontSize: 13, color: '$danger' },
  failed: {
    fontSize: 11,
    color: '$danger',
    paddingStart: 12,
    paddingBottom: 4,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingStart: 10,
    paddingEnd: 10,
    paddingTop: 6,
    paddingBottom: 6,
    borderTopWidth: 1,
    borderColor: '$border',
  },
  footerLabel: { fontSize: 11, color: '$textMuted' },
});

// `hour12: false` rather than the locale's own choice, because this column is
// a fixed width beside a message and "09:28 AM" is half again as wide as
// "09:28" — enough to wrap onto two lines in an en-US locale, which is what it
// did. A chat timestamp is a glance, not a reading, so the stable width is
// worth more here than matching the desktop's clock format.
const clock = (at) =>
  new Date(at).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

// ---------------------------------------------------------------------------

/** One pane's failure is one pane's failure — see the header. */
class PaneBoundary extends React.Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <box style={s.error}>
        <text style={s.errorText}>{`${this.props.channel} broke`}</text>
        <text style={{ fontSize: 12, color: '$textMuted' }}>
          {this.state.error.message}
        </text>
        <Button onPress={() => this.setState({ error: null })}>
          Reload the pane
        </Button>
      </box>
    );
  }
}

/**
 * The scrollback, pinned to the bottom only while the reader is already
 * there. Scroll up and new lines stop yanking the view — the check is
 * against the *previous* frame's offset, because by the time the effect runs
 * the content is already taller.
 */
function Scrollback({ channel, messages }) {
  const ref = useRef(null);
  const pinned = useRef(true);

  useEffect(() => {
    const node = ref.current;
    if (node && pinned.current) node.scrollTo(node.contentHeight);
  }, [messages]);

  return (
    <box
      ref={ref}
      style={s.scroll}
      role="log"
      aria-label={`messages in ${channel}`}
      // Every channel is mounted at once, so a query needs to say which —
      // `role="log"` alone would match three nodes.
      data-testname={`log-${channel}`}
      onScroll={(ev) => {
        pinned.current = ev.scrollY + ev.viewportHeight >= ev.contentHeight - 8;
      }}
    >
      {messages.map((m) => (
        // The id is on the row so a test can watch it: a message keeps the id
        // it was given optimistically, and that is what stops it appearing
        // twice while the send resolves.
        <box key={m.id} data-testname={`msg-${m.id}`} style={s.line}>
          <text style={s.who}>{m.from}</text>
          <text
            style={[
              s.what,
              m.pending && s.whatPending,
              m.system && s.whatSystem,
            ]}
          >
            {m.text}
          </text>
          <text style={s.tick}>{m.pending ? '' : m.mine ? '✓' : ''}</text>
          <text style={s.when}>{clock(m.at)}</text>
        </box>
      ))}
    </box>
  );
}

/**
 * A channel. Everything that must survive a switch — the draft, the scroll
 * offset, the failure notice — is state in here, and <Activity> is what keeps
 * it. Nothing below serialises anything to the parent.
 */
function ChannelPane({ channel, transport, nick, messages, onDelivered }) {
  const history = use(loadHistory(transport, channel));
  const [draft, setDraft] = useState('');
  const [failed, setFailed] = useState(null);
  const [, startTransition] = useTransition();

  const all = useMemo(() => [...history, ...messages], [history, messages]);

  // The reducer has to be idempotent: React re-applies it on top of the
  // newest state until the transition ends, and the transition ends *after*
  // the delivered message has already joined `messages`. Append blindly and
  // the line is briefly there twice.
  const [shown, addOptimistic] = useOptimistic(all, (list, msg) =>
    list.some((m) => m.id === msg.id)
      ? list
      : [...list, { ...msg, pending: true, mine: true }],
  );

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    const local = {
      id: messageId(),
      channel,
      from: nick,
      text,
      at: Date.now(),
    };
    setDraft('');
    setFailed(null);
    startTransition(async () => {
      addOptimistic(local);
      try {
        const delivered = await transport.send(channel, text, nick);
        // **Keep the local id.** The optimistic reducer recognises the
        // delivered message as the one already on screen by id, and a
        // transport is free to mint its own — so taking the server's id here
        // means the reducer no longer sees `local` in the list, adds its copy
        // back, and the message is on screen twice until the transition ends.
        // Long enough to see, and gone before you can point at it.
        //
        // A message this app sent is identified by the id this app gave it.
        // That is also what a real protocol does: a client-generated nonce
        // the server echoes, precisely so the sender can match the two up.
        onDelivered({ ...delivered, id: local.id, mine: true });
      } catch (err) {
        setFailed(err.message);
      }
    });
  };

  return (
    <box style={{ flexGrow: 1 }}>
      <Scrollback channel={channel} messages={shown} />
      {failed ? <text style={s.failed}>{`not sent — ${failed}`}</text> : null}
      <box style={s.composer}>
        <textinput
          style={s.input}
          value={draft}
          placeholder={`message ${channel}`}
          aria-label={`message ${channel}`}
          onChange={(ev) => setDraft(ev.value)}
          onSubmit={send}
        />
        <Button onPress={send} disabled={!draft.trim()}>
          Send
        </Button>
      </box>
    </box>
  );
}

/** Deliberately as tall as the pane it replaces — see the header. */
function PaneFallback() {
  return (
    <box style={s.fallback} aria-label="loading history">
      {[92, 74, 86, 60].map((w, i) => (
        <box key={i} style={[s.ghost, { width: `${w}%` }]} />
      ))}
    </box>
  );
}

function Breaker() {
  throw new Error('a render threw, on purpose');
}

// ---------------------------------------------------------------------------

export function ChatPanel({ transport, nick = 'you' }) {
  // The sidebar shows what the transport actually joined, not a constant. A
  // real server takes a channel list from the command line, and a window
  // listing three channels while the connection sits in a different three is
  // the kind of wrong that looks like a rendering bug.
  const channels = transport.channels ?? CHANNELS;
  const [current, setCurrent] = useState(channels[0]);
  const [byChannel, setByChannel] = useState(() =>
    Object.fromEntries(channels.map((c) => [c, []])),
  );
  const [unread, setUnread] = useState({});
  const [status, setStatus] = useState(transport.status);
  const [broken, setBroken] = useState(null);
  const [flaky, setFlaky] = useState(false);

  const currentRef = useRef(current);
  currentRef.current = current;

  useEffect(() => {
    const offMessage = transport.onMessage((msg) => {
      setByChannel((prev) => ({
        ...prev,
        [msg.channel]: [...(prev[msg.channel] ?? []), msg],
      }));
      if (msg.channel !== currentRef.current) {
        setUnread((prev) => ({
          ...prev,
          [msg.channel]: (prev[msg.channel] ?? 0) + 1,
        }));
      }
    });
    const offStatus = transport.onStatus(setStatus);
    transport.connect();
    return () => {
      offMessage();
      offStatus();
      transport.close();
    };
  }, [transport]);

  const open = useCallback((channel) => {
    setCurrent(channel);
    setUnread((prev) => ({ ...prev, [channel]: 0 }));
  }, []);

  const deliver = useCallback((msg) => {
    setByChannel((prev) => ({
      ...prev,
      [msg.channel]: [...(prev[msg.channel] ?? []), msg],
    }));
  }, []);

  const dotColor =
    status === 'online'
      ? '$success'
      : status === 'connecting'
        ? '$warning'
        : '$danger';

  return (
    <box style={s.root}>
      <box style={s.sidebar} role="list" aria-label="channels">
        <text style={s.sidebarHead}>CHANNELS</text>
        {channels.map((channel) => {
          const on = channel === current;
          return (
            <box
              key={channel}
              style={[s.channel, on && s.channelOn]}
              role="listitem"
              aria-label={channel}
              aria-selected={on}
              focusable
              onClick={() => open(channel)}
            >
              <text style={[s.channelName, on && s.channelNameOn]}>
                {channel}
              </text>
              {unread[channel] ? (
                <box style={s.unreadPill}>
                  <text style={s.unread}>{String(unread[channel])}</text>
                </box>
              ) : null}
            </box>
          );
        })}
      </box>

      <box style={s.main}>
        <box style={s.banner}>
          <box style={[s.dot, { backgroundColor: dotColor }]} />
          <text style={s.bannerText}>
            {status === 'online'
              ? `connected as ${nick}`
              : status === 'connecting'
                ? 'connecting…'
                : 'offline — the chat server, not the X server'}
          </text>
          <Button
            onPress={() => transport.connect()}
            disabled={status === 'online'}
          >
            Reconnect
          </Button>
        </box>

        {channels.map((channel) => (
          <Activity
            key={channel}
            mode={channel === current ? 'visible' : 'hidden'}
          >
            <PaneBoundary channel={channel}>
              <Suspense fallback={<PaneFallback />}>
                {broken === channel ? (
                  <Breaker />
                ) : (
                  <ChannelPane
                    channel={channel}
                    transport={transport}
                    nick={nick}
                    messages={byChannel[channel] ?? []}
                    onDelivered={deliver}
                  />
                )}
              </Suspense>
            </PaneBoundary>
          </Activity>
        ))}

        <box style={s.footer}>
          <Switch
            checked={flaky}
            onChange={(ev) => {
              setFlaky(ev.value);
              transport.state.failNext = ev.value;
            }}
            aria-label="drop the next send"
          />
          <text style={s.footerLabel}>drop the next send</text>
          <Button onPress={() => setBroken(broken ? null : current)}>
            {broken ? 'unbreak' : 'break the pane'}
          </Button>
        </box>
      </box>
    </box>
  );
}

function transportFromEnv() {
  const host = process.env.CHAT_IRC;
  if (!host) return fixtureTransport();
  const arg = (name) =>
    process.argv
      .find((a) => a.startsWith(`--${name}=`))
      ?.split('=')
      .slice(1)
      .join('=');
  // The three channel names this demo uses are real ones on a real network,
  // and joining them because an example hardcoded them is rude. Say which.
  const channels = (process.env.CHAT_CHANNELS ?? arg('channels'))
    ?.split(',')
    .map((c) => c.trim())
    .filter(Boolean);
  return ircTransport({
    host,
    port: Number(process.env.CHAT_IRC_PORT ?? 6667),
    nick: arg('nick') || undefined,
    channels: channels?.length ? channels : undefined,
  });
}

export function App({ transport, nick }) {
  const chosen = useMemo(() => transport ?? transportFromEnv(), [transport]);
  return (
    <window
      width={720}
      height={520}
      title="react-x11 chat"
      minWidth={520}
      minHeight={360}
      style={{ backgroundColor: '$background' }}
    >
      <ChatPanel transport={chosen} nick={nick ?? chosen.nick ?? 'you'} />
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN && !import.meta.hot) {
  const root = await createRoot();
  root.render(<App />);
}

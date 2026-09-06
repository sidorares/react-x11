// Downloads — one banner that counts up, rather than eleven that stack.
//
//   REACT_X11_BACKEND=cocoa npm run examples:notify   # the notification centre
//   npm run examples:notify                           # X11: the desktop's daemon
//
// A notification is easy to post and easy to get wrong. The interesting part
// is not `notify()` — it is everything after it: the banner that **updates in
// place** while a transfer runs, the **buttons** on it, and finding out **what
// the user did** with it. This app is a download manager that uses all three,
// and that changes its behaviour when the machine cannot.
//
// ## What to try
//
//   Start one      a banner appears and its body counts 25%, 50%, 75% — the
//                  same banner, updated (`handle.update({ body })`), not a
//                  new one each time. That is the whole reason the handle
//                  exists; on the freedesktop daemon it is `replaces_id`.
//
//   Let it finish  the banner becomes "Download finished" and grows an
//                  **Open** button. Press it: the row in the window says
//                  opened. That is `actions` + `onAction`, round-tripped
//                  from the desktop back into React state.
//
//   Cancel         press Cancel on the banner while it runs — the transfer
//                  stops and the banner is taken down (`handle.close()`).
//
//   Dismiss one    swipe or close a banner yourself and the row notes how it
//                  went away: `onClose(reason)` — `dismissed` when you did
//                  it, `expired` when it timed out.
//
// ## The rung decides what this app does
//
// Four rungs (docs/notifications.md), and only the top two can update a
// banner in place or report an action. So this app **asks first**
// (`notifier.backend`) and posts differently: where it can update, it posts
// at the start and counts up; where it cannot — `osascript`, `notify-send` —
// posting per step would be four banners for one download, so it stays quiet
// and posts once, at the end. The footer says which world it is in. Getting
// this wrong is the most common notification bug there is, which is why the
// example is built around it rather than around `notify()`.
//
// ## The seam
//
// `fixtureTransfers()` is the downloads: a timer and a step count. A real one
// would be an HTTP stream. `test/notify-example.test.js` drives this same app
// through one with the clock stopped.
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { createRoot, useNotifier } from '../src/index.js';

/**
 * The world, behind an interface: transfers that make progress over time.
 * `start(name)` begins one and `subscribe(cb)` reports every step;
 * `tickMs: 0` never advances on its own, which is the shape the test uses.
 */
export function fixtureTransfers({ tickMs = 700, steps = 4 } = {}) {
  let seq = 0;
  const listeners = new Set();
  const live = new Map();
  const emit = (t) => {
    for (const cb of [...listeners]) cb({ ...t });
  };
  const api = {
    tickMs,
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    start(name) {
      const id = ++seq;
      const t = {
        id,
        name: name ?? `report-${id}.pdf`,
        step: 0,
        steps,
        done: false,
        cancelled: false,
      };
      live.set(id, t);
      emit(t);
      if (tickMs > 0) {
        const timer = setInterval(() => {
          if (!api.advance(id)) clearInterval(timer);
        }, tickMs);
        timer.unref?.();
      }
      return t;
    },
    /** One step forward. False once the transfer is over. */
    advance(id) {
      const t = live.get(id);
      if (!t) return false;
      t.step += 1;
      if (t.step >= t.steps) {
        t.done = true;
        live.delete(id);
        emit(t);
        return false;
      }
      emit(t);
      return true;
    },
    cancel(id) {
      const t = live.get(id);
      if (!t) return;
      t.cancelled = true;
      live.delete(id);
      emit(t);
    },
  };
  return api;
}

const SURFACE = '#1d2028';
const CARD = '#2a2d39';
const INK = '#e8eaf0';
const DIM = '#9aa0b4';
const ACCENT = '#5c6bc0';
const GOOD = '#43b581';

const pct = (t) => Math.round((t.step / t.steps) * 100);

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
        ':hover': {
          backgroundColor: tone === 'accent' ? '#6b7ad0' : '#343848',
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

function Row({ row }) {
  const done = row.done && !row.cancelled;
  return (
    <box
      style={{
        gap: 6,
        paddingTop: 8,
        paddingBottom: 8,
        paddingLeft: 12,
        paddingRight: 12,
        borderRadius: 6,
        backgroundColor: CARD,
      }}
    >
      <box style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <text style={{ color: INK, fontSize: 14, flexGrow: 1 }}>
          {row.name}
        </text>
        <text style={{ color: done ? GOOD : DIM, fontSize: 12 }}>
          {row.cancelled
            ? 'cancelled'
            : done
              ? row.opened
                ? 'opened'
                : 'finished'
              : `${pct(row)}%`}
        </text>
      </box>
      {/* the progress bar is two boxes; no component library in examples */}
      <box
        style={{
          height: 4,
          borderRadius: 2,
          backgroundColor: '#3a3e4d',
          overflow: 'hidden',
        }}
      >
        <box
          style={{
            width: `${row.cancelled ? 0 : pct(row)}%`,
            height: 4,
            borderRadius: 2,
            backgroundColor: done ? GOOD : ACCENT,
          }}
        />
      </box>
      <text hidden={!row.note} style={{ color: DIM, fontSize: 11 }}>
        {row.note}
      </text>
    </box>
  );
}

export default function App({ source }) {
  const transfers = useMemo(() => source ?? fixtureTransfers(), [source]);
  const notifier = useNotifier();
  const [rows, setRows] = useState([]);

  // Only the top two rungs can replace a banner in place or tell us what the
  // user did with it. Everything below posts once, at the end (see the header).
  const liveBanners =
    notifier.backend === 'cocoa' || notifier.backend === 'dbus';

  // One in-flight notification per transfer. A promise, not a handle: a fast
  // transfer can finish before the first `notify()` resolves, so every later
  // update chains off the post rather than racing it.
  const banners = useRef(new Map());

  const patch = useCallback((id, fields) => {
    setRows((list) => list.map((r) => (r.id === id ? { ...r, ...fields } : r)));
  }, []);

  const onAction = useCallback(
    (id, key) => {
      if (key === 'cancel') transfers.cancel(id);
      else if (key === 'open')
        patch(id, { opened: true, note: 'opened from the notification' });
    },
    [transfers, patch],
  );

  const onClose = useCallback(
    (id, reason) => patch(id, { note: `notification ${reason}` }),
    [patch],
  );

  useEffect(
    () =>
      transfers.subscribe((t) => {
        setRows((list) =>
          list.some((r) => r.id === t.id)
            ? list.map((r) => (r.id === t.id ? { ...r, ...t } : r))
            : [{ ...t }, ...list],
        );
        if (!notifier.available) return;

        const post = (options) => {
          const p = notifier
            .notify({
              ...options,
              onAction: (key) => onAction(t.id, key),
              onClose: (reason) => onClose(t.id, reason),
            })
            .catch(() => null);
          banners.current.set(t.id, p);
          return p;
        };
        const withBanner = (fn) => {
          const p = banners.current.get(t.id);
          if (p) p.then((h) => h && fn(h)).catch(() => {});
        };

        if (t.cancelled) {
          withBanner((h) => h.close());
          banners.current.delete(t.id);
          return;
        }
        if (t.done) {
          const finished = {
            summary: 'Download finished',
            body: t.name,
            actions: [{ key: 'open', label: 'Open' }],
          };
          // where a banner can be replaced, the one that was counting becomes
          // this; where it cannot, this is the only banner the download posts
          if (liveBanners && banners.current.has(t.id)) {
            withBanner((h) => h.update(finished));
          } else {
            post(finished);
          }
          return;
        }
        if (!liveBanners) return; // quiet until it finishes — see the header
        if (t.step === 0) {
          post({
            summary: `Downloading ${t.name}`,
            body: '0%',
            urgency: 'low',
            actions: [{ key: 'cancel', label: 'Cancel' }],
          });
        } else {
          withBanner((h) => h.update({ body: `${pct(t)}%` }));
        }
      }),
    [transfers, notifier, liveBanners, onAction, onClose],
  );

  return (
    <window
      width={420}
      height={480}
      title="Downloads"
      minWidth={340}
      wmClass="com.example.x11downloads"
      style={{ backgroundColor: SURFACE }}
    >
      <box style={{ flexGrow: 1, padding: 16, gap: 12 }}>
        <box style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <text style={{ color: INK, fontSize: 20, flexGrow: 1 }}>
            Downloads
          </text>
          <Button
            label="Start a download"
            tone="accent"
            onPress={() => transfers.start()}
          />
        </box>

        <box style={{ flexGrow: 1, gap: 6, overflow: 'scroll' }}>
          {rows.length === 0 ? (
            <text style={{ color: DIM, fontSize: 13 }}>
              Nothing yet. Start one and watch the banner count up — then press
              Open on it when it finishes.
            </text>
          ) : (
            rows.map((r) => <Row key={r.id} row={r} />)
          )}
        </box>

        <text style={{ color: DIM, fontSize: 11 }}>
          {notifier.available
            ? `notifications: ${notifier.backend}${
                liveBanners
                  ? ' — updates in place, reports actions'
                  : ' — posts once at the end; this rung cannot update or report back'
              }`
            : 'no notification service here — the list is the whole story'}
        </text>
      </box>
    </window>
  );
}

if (!process.env.REACT_X11_NO_AUTORUN && !import.meta.hot) {
  const root = await createRoot({ cocoa: { appName: 'Downloads' } });
  root.render(<App />);
}

// A status menu — an app that lives in the menu bar, not in a window.
//
//   REACT_X11_BACKEND=cocoa npm run examples:tray   # a real menu-bar item
//   npm run examples:tray                           # X11: the window, tray inert
//
// The tray is the one piece of desktop furniture an app can own that is not a
// window: an icon in the system status bar with a menu hanging off it. This
// app is a presence indicator — Available, Busy, Away — and on the cocoa
// backend its whole UI is the tray item: the icon shows the state, the menu
// changes it. The window is the companion for machines with no tray, where it
// is the whole app instead; `available` is what the app branches on.
//
// ## What to try (cocoa)
//
//   The menu bar   an icon appears up top. Click it: the three states, the
//                  current one checked, and Quit. Pick one — the icon
//                  changes to match. That is `useTray({ icon, tooltip, menu })`,
//                  the `menu` being the same `items` array `MenuBar` takes.
//
//   No Dock tile   run it with `activationPolicy: 'accessory'` (uncomment
//                  below) and it is a true menu-bar app: no Dock icon, no
//                  ⌘-Tab entry, just the status item. That is the shape a
//                  tray app usually wants, and why the two features pair.
//
// ## What to try (X11)
//
//   The window     there is no `NSStatusItem` on X11 — the freedesktop tray
//                  (StatusNotifierItem) is not built yet
//                  ([#353](https://github.com/sidorares/react-x11/issues/353))
//                  — so `useTray` is inert and `available` is false. The app
//                  falls back to its window, which does the same job with
//                  buttons. The footer says which world it is in.
//
// ## No seam here, on purpose
//
// Unlike the other outward-facing examples, this app's state comes from the
// user, not the world — there is nothing to fake. `test/tray-example.test.js`
// drives it through the tray menu the same way a click would.
import React, { useCallback, useMemo, useState } from 'react';

import { createRoot, useApp, useTray } from '../src/index.js';

// Each status: the SF Symbol the menu-bar icon shows, a colour for the
// window's dot, and a label. The symbol names are Apple's; on a machine with
// no tray they are never asked for.
const STATUSES = {
  available: { symbol: 'circle.fill', color: '#43b581', label: 'Available' },
  busy: { symbol: 'minus.circle.fill', color: '#f04747', label: 'Busy' },
  away: { symbol: 'moon.fill', color: '#faa61a', label: 'Away' },
};
const ORDER = ['available', 'busy', 'away'];

const SURFACE = '#1e2129';
const CARD = '#2b2e3a';
const CARD_HOVER = '#343848';
const INK = '#e8eaf0';
const DIM = '#9aa0b4';

function Swatch({ status, active, onPick }) {
  const s = STATUSES[status];
  return (
    <box
      onClick={() => onPick(status)}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingTop: 8,
        paddingBottom: 8,
        paddingLeft: 12,
        paddingRight: 12,
        borderRadius: 8,
        backgroundColor: active ? CARD_HOVER : CARD,
        cursor: 'pointer',
        ':hover': { backgroundColor: CARD_HOVER },
      }}
    >
      <box
        style={{
          width: 12,
          height: 12,
          borderRadius: 6,
          backgroundColor: s.color,
        }}
      />
      <text style={{ color: INK, fontSize: 14, flexGrow: 1 }}>{s.label}</text>
      <text
        hidden={!active}
        style={{ color: DIM, fontSize: 13 }}
      >{`current`}</text>
    </box>
  );
}

export default function App({ initial = 'available', onQuit = () => {} }) {
  const [status, setStatus] = useState(initial);

  // The tray menu: one item per status, the current one checked, then Quit.
  // Same `items` vocabulary as `MenuBar` and `useDockMenu` — `iconName` is an
  // SF Symbol, `toggleState` draws the check.
  const menu = useMemo(
    () => [
      ...ORDER.map((key) => ({
        label: STATUSES[key].label,
        iconName: STATUSES[key].symbol,
        toggleType: 'radio',
        toggleState: key === status ? 1 : 0,
        onSelect: () => setStatus(key),
      })),
      { type: 'separator' },
      { label: 'Quit', onSelect: onQuit },
    ],
    [status, onQuit],
  );

  const { available } = useTray({
    icon: STATUSES[status].symbol,
    tooltip: `Status: ${STATUSES[status].label}`,
    menu,
  });

  const pick = useCallback((key) => setStatus(key), []);

  // The companion window. On cocoa it is the same controls the menu offers,
  // for when the app is open anyway; on X11 it is the whole app.
  const app = useApp();
  const trayLive = typeof app?.createStatusItem === 'function';

  return (
    <window
      width={300}
      height={280}
      title={`Status — ${STATUSES[status].label}`}
      wmClass="com.example.x11status"
      style={{ backgroundColor: SURFACE }}
    >
      <box style={{ flexGrow: 1, padding: 16, gap: 10 }}>
        <box style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <box
            style={{
              width: 14,
              height: 14,
              borderRadius: 7,
              backgroundColor: STATUSES[status].color,
            }}
          />
          <text style={{ color: INK, fontSize: 18, flexGrow: 1 }}>Status</text>
        </box>

        <box style={{ gap: 6 }}>
          {ORDER.map((key) => (
            <Swatch
              key={key}
              status={key}
              active={key === status}
              onPick={pick}
            />
          ))}
        </box>

        <box style={{ flexGrow: 1 }} />

        <text style={{ color: DIM, fontSize: 11 }}>
          {available
            ? 'In the menu bar — click the icon up top.'
            : 'No menu-bar tray here (X11, #353) — this window is the app.'}
          {trayLive ? '' : ''}
        </text>
      </box>
    </window>
  );
}

// ---------------------------------------------------------------------------
// Autorun. `activationPolicy: 'accessory'` would make this a menu-bar-only
// app on macOS — no Dock tile, no ⌘-Tab entry — which is what a tray app
// usually wants; left as `'regular'` here so the companion window is easy to
// find while you are reading the code.
// ---------------------------------------------------------------------------

if (!process.env.REACT_X11_NO_AUTORUN && !import.meta.hot) {
  const root = await createRoot({
    cocoa: { appName: 'Status', activationPolicy: 'regular' },
  });
  const quit = () => {
    root.unmount().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  root.render(<App onQuit={quit} />);
}

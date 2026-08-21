// Deep links: the manual harness for `com.example.myapp://…`.
//
// A lab rather than a tour example: it is not a program anybody would keep
// running, it is the rig for the two launch paths a broker cannot fake
// (AGENTS.md, "Writing an example").
//
//   npm run labs:urischeme           # needs an X server / DISPLAY
//
// The two branches that matter here are the two a broker cannot fake — a
// launch that *starts* the process through D-Bus activation, and the
// `.desktop`/MIME route that `xdg-open` takes — so this is what covers them.
// The window prints the install snippet it needs and then narrates every
// launch it receives.
//
// The pass, once the two files below exist:
//
//   gio open com.example.myapp://test                            # path A
//   env -u XDG_CURRENT_DESKTOP xdg-open com.example.myapp://test # path B
//
// Run each twice — with this closed, and with it running. Closed, it should
// start and show the link. Running, the link should appear in *this* window
// and the window should come to the front, with no second copy anywhere.
//
// See docs/uri-schemes.md.
import React, { useRef, useState } from 'react';

import {
  activateWindow,
  createRoot,
  createStyles,
  registerApplication,
  useAppActivate,
  useAppOpen,
} from '../../src/index.js';

const APP_ID = 'com.example.myapp';

const s = createStyles({
  root: { flexDirection: 'column', padding: 14, gap: 10, flexGrow: 1 },
  heading: { color: '$text', fontSize: 14 },
  dim: { color: '$textMuted', fontSize: 11 },
  panel: {
    flexDirection: 'column',
    gap: 4,
    padding: 10,
    backgroundColor: '$surface',
    borderColor: '$track',
    borderWidth: 1,
    borderRadius: 6,
    flexGrow: 1,
  },
  line: { color: '$text', fontSize: 11 },
  empty: { color: '$border', fontSize: 11 },
});

let registration = null;

// Registration happens **before** createRoot, and before anything renders: on
// the D-Bus path the bus started this process because someone called `Open`,
// and that call is outstanding while we boot. Skipped when this file is only
// being imported, since owning a name on the session bus is not something an
// import should do.
if (!process.env.REACT_X11_NO_AUTORUN) {
  registration = await registerApplication({
    appId: APP_ID,
    schemes: [APP_ID],
  });
  if (registration?.role === 'secondary') {
    // The link went to the copy that is already running. Nothing to draw.
    console.log(`${APP_ID} is already running — link forwarded.`);
    process.exit(0);
  }
}

const INSTALL = [
  `~/.local/share/applications/${APP_ID}.desktop:`,
  '  [Desktop Entry]',
  '  Type=Application',
  '  Name=react-x11 deep links',
  // Whatever command actually starts this — an absolute path, since a
  // launcher has your shell's PATH and not your terminal's.
  '  Exec=/path/to/npx tsx /path/to/examples/urischeme.jsx %u',
  '  DBusActivatable=true',
  `  StartupWMClass=${APP_ID}`,
  `  MimeType=x-scheme-handler/${APP_ID};`,
  '',
  '  update-desktop-database ~/.local/share/applications',
];

function App() {
  const win = useRef(null);
  const [log, setLog] = useState([]);
  const note = (text) => setLog((all) => [...all, text].slice(-12));

  useAppOpen((uris, ctx) => {
    note(`Open  ${uris.join(' ')}   (t=${ctx.timestamp ?? 'none'})`);
    // The timestamp is the whole feature: with the launch's own, the window
    // manager lets the window come forward. With none, it may decline and
    // blink the taskbar entry instead.
    activateWindow(win, { timestamp: ctx.timestamp });
  });

  useAppActivate((ctx) => {
    note(`Activate   (t=${ctx.timestamp ?? 'none'})`);
    activateWindow(win, { timestamp: ctx.timestamp });
  });

  return (
    <window
      ref={win}
      width={680}
      height={420}
      wmClass={APP_ID}
      title="react-x11 — deep links"
      style={{ backgroundColor: '$surfaceHover' }}
    >
      <box style={s.root}>
        <text style={s.heading}>
          {registration
            ? `owning ${APP_ID} at ${registration.objectPath}`
            : 'no session bus — argv links only, and no single instance'}
        </text>
        <box style={s.panel}>
          {log.length === 0 ? (
            <text style={s.empty}>
              nothing yet — open {APP_ID}://test from another terminal
            </text>
          ) : (
            log.map((line, i) => (
              <text key={i} style={s.line}>
                {line}
              </text>
            ))
          )}
        </box>
        <box style={s.panel}>
          {INSTALL.map((line, i) => (
            <text key={i} style={s.dim}>
              {line || ' '}
            </text>
          ))}
        </box>
      </box>
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<App />);
}

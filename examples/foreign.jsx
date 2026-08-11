// <foreign>: another application's window, inside this one.
//
// A pane that spawns a program into itself and shows what happened to it.
// Two paths in one demo, because they are the two ways an embed ever starts:
//
//   - **adopt** (no `windowId`): the pane's own X window id is handed to the
//     program on its command line, and whatever it puts inside is taken.
//     `xterm -into WID` and `mpv --wid=WID` work this way, and so does
//     anything else that has to be *given* a window before it makes one.
//   - **embed** (`windowId={id}`): a window that already exists — one found
//     by a window manager, a picker, or a previous pane letting go of it.
//     Closing the pane here re-embeds the same client in the other slot,
//     which is the whole point: the window is not ours, and it survives.
//
// Run with: npm run examples:foreign     (needs an X server and a program
//                                         that accepts a window id)
//
//   FOREIGN_CMD="mpv --wid=%WID% clip.mp4" npm run examples:foreign
//
// `%WID%` is replaced with the pane's window id; the default is
// `xterm -into %WID%`, which is the one most systems have.
import { spawn } from 'node:child_process';
import React, { useCallback, useRef, useState } from 'react';

import { Button } from '../src/components/index.js';
import { createRoot } from '../src/index.js';
import { ctrlChordLetter } from '../src/keysyms.js';

const COMMAND = process.env.FOREIGN_CMD ?? 'xterm -into %WID%';

/** The command, with `%WID%` filled in. Naive splitting on purpose — this is
 *  a demo, and a real app would take argv rather than a string. */
function commandFor(windowId) {
  const [program, ...args] = COMMAND.split(/\s+/).map((token) =>
    token.replaceAll('%WID%', String(windowId)),
  );
  return { program, args };
}

/**
 * A pane that starts a program into itself.
 *
 * `onReady` is what makes this possible: it carries the pane's own X window
 * id, and it fires before anything is embedded — which has to be true,
 * because the program cannot be started without it.
 */
function SpawningPane({ onStatus, onWindow }) {
  const started = useRef(false);

  const start = useCallback(
    ({ windowId }) => {
      // onReady fires again if the socket is rebuilt; the program is not
      if (started.current) return;
      started.current = true;
      const { program, args } = commandFor(windowId);
      onStatus(`starting ${program}…`);
      const child = spawn(program, args, { stdio: 'ignore' });
      child.on('error', (err) =>
        onStatus(`could not start ${program}: ${err.message}`),
      );
      child.on('exit', (code) => onStatus(`${program} exited (${code})`));
    },
    [onStatus],
  );

  return (
    <foreign
      style={{ flexGrow: 1, backgroundColor: '#101014' }}
      onReady={start}
      onEmbedded={({ id, xembed, version }) => {
        onWindow(id);
        onStatus(
          xembed
            ? `embedded ${id} — speaks XEmbed v${version}`
            : `embedded ${id} — plain reparenting, no _XEMBED_INFO`,
        );
      }}
      onClientGone={() => {
        onWindow(null);
        onStatus('the client went away');
      }}
      onRequestFocus={() => onStatus('the client asked for the focus')}
      onError={(err) => onStatus(`embed failed: ${err.message}`)}
    />
  );
}

function App() {
  const [status, setStatus] = useState(`waiting — ${COMMAND}`);
  // the id the pane is holding, so the second pane can take it over
  const [windowId, setWindowId] = useState(null);
  const [moved, setMoved] = useState(false);

  return (
    <window
      width={720}
      height={520}
      title="react-x11 — <foreign>"
      // The chord rule, made visible. A `<foreign>` forwards the keys it is
      // given, and `preventDefault()` here is what keeps one — the same word,
      // and the same ordering, that lets a `<textinput>` keep Tab.
      onKeyDown={(ev) => {
        if (ev.ctrlKey && ctrlChordLetter(ev) === 0x6b /* k */) {
          ev.preventDefault();
          setStatus(`Ctrl+K stayed here (${new Date().toLocaleTimeString()})`);
        }
      }}
    >
      <box
        style={{
          flexGrow: 1,
          padding: 12,
          gap: 10,
          backgroundColor: '$background',
        }}
      >
        <box style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <text style={{ fontSize: 13, flexGrow: 1 }}>{status}</text>
          <Button disabled={!windowId} onPress={() => setMoved((m) => !m)}>
            {moved ? 'Move back' : 'Move to the other pane'}
          </Button>
        </box>

        {/*
          The same client, in one pane or the other. Unmounting the pane it
          is in hands the window back to the root rather than destroying it,
          which is what lets the other pane pick it up by id — and what would
          happen to a real application if this app simply quit.
        */}
        {moved && windowId ? (
          <box style={{ flexDirection: 'row', flexGrow: 1, gap: 10 }}>
            <box
              style={{
                flexGrow: 1,
                borderWidth: 1,
                borderColor: '$border',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <text style={{ fontSize: 12, color: '$dim' }}>empty</text>
            </box>
            <foreign
              windowId={windowId}
              style={{ flexGrow: 1, backgroundColor: '#101014' }}
              onEmbedded={({ id }) =>
                setStatus(`re-embedded ${id} on the right`)
              }
              onClientGone={() => {
                setWindowId(null);
                setStatus('the client went away');
              }}
            />
          </box>
        ) : (
          <SpawningPane onStatus={setStatus} onWindow={setWindowId} />
        )}

        <text style={{ fontSize: 11, color: '$dim' }}>
          Keys go to the app first: Ctrl+K is taken here and never reaches the
          client. Everything else is forwarded — click the pane and type.
        </text>
      </box>
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<App />);
}

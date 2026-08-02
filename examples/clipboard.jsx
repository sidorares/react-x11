// A clipboard inspector — and the manual interop harness for the type
// vocabulary.
//
//   npm run examples:clipboard      # needs an X server / DISPLAY
//
// The left column copies; the right column shows what is on the clipboard
// right now and pastes it back. Point it at real applications: copy in
// GTK's gedit, in a terminal, in Firefox, or select files in Nautilus and
// press Ctrl+C, and watch which type names actually arrive. That list is
// the whole reason `read('text')` and `read('files')` take groups rather
// than exact names — see docs/clipboard.md.
//
// Things worth trying:
//   - Copy from a terminal: usually STRING only, no UTF8_STRING.
//   - Copy from a GTK app: text/plain;charset=utf-8 first, which is the
//     flavour readText() cannot ask for and read('text') finds.
//   - Copy a link in Firefox: text/x-moz-url, which is in the `uris` group
//     rather than `text` — deliberately, since it is UTF-16 and carries a
//     title on a second line.
//   - Copy files in a file manager: text/uri-list, parsed by readFiles().
//   - Then copy *from* here and paste into those applications: the HTML
//     button offers text/html and text/plain at once, so a rich editor and
//     a terminal each take what they understand.
import React, { useCallback, useEffect, useState } from 'react';

import { createRoot, createStyles, useClipboard } from '../src/index.js';

const s = createStyles({
  root: { flexDirection: 'row', padding: 12, gap: 12, flexGrow: 1 },
  // minWidth 0 or the long button labels set a min-content width the
  // column will not shrink below, and the right half runs off the window
  left: { flexDirection: 'column', gap: 8, width: 190 },
  col: { flexDirection: 'column', gap: 8, flexGrow: 1, minWidth: 0 },
  panel: {
    flexDirection: 'column',
    gap: 6,
    padding: 10,
    backgroundColor: '#ffffff',
    borderColor: '#dfe6e9',
    borderWidth: 1,
    borderRadius: 6,
    flexGrow: 1,
    minWidth: 0,
  },
  heading: { color: '#2d3436', fontSize: 13 },
  dim: { color: '#7f8c8d', fontSize: 11 },
  button: {
    padding: 6,
    backgroundColor: '#f5f6fa',
    borderColor: '#b2bec3',
    borderWidth: 1,
    borderRadius: 4,
    color: '#2d3436',
    ':hover': { backgroundColor: '#e8eaf0' },
  },
  mono: { color: '#2d3436', fontSize: 11 },
  empty: { color: '#b2bec3', fontSize: 11 },
});

function Button({ label, onClick }) {
  return (
    <box style={s.button} onMouseUp={onClick}>
      <text style={s.heading}>{label}</text>
    </box>
  );
}

/** A 1x1 red PNG, so the image button has something real to offer. */
const RED_DOT = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function App() {
  const clipboard = useClipboard();
  const [offered, setOffered] = useState([]);
  const [pasted, setPasted] = useState(null);
  // one line, and short: an unbounded string here sets a min-content width
  // the whole column is then sized to, and the panel runs off the window
  const [note, setNoteRaw] = useState('nothing yet');
  const setNote = useCallback(
    (text) => setNoteRaw(String(text).slice(0, 58)),
    [],
  );

  const refresh = useCallback(async () => {
    try {
      setOffered(await clipboard.targets());
    } catch (err) {
      setNote(`targets() failed: ${err.message}`);
    }
  }, [clipboard]);

  // The list follows the clipboard rather than being polled: watch() is a
  // server-side subscription, so this costs nothing until something copies.
  useEffect(() => {
    let stop;
    let live = true;
    clipboard
      .watch(() => refresh())
      .then((fn) => {
        if (live) stop = fn;
        else fn();
      })
      .catch((err) => setNote(`watch() unavailable: ${err.message}`));
    refresh();
    return () => {
      live = false;
      stop?.();
    };
  }, [clipboard, refresh]);

  const copy = (data, label) => async () => {
    try {
      await clipboard.write(data);
      setNote(`copied ${label}`);
    } catch (err) {
      setNote(`copy failed: ${err.message}`);
    }
  };

  const paste = (label, run) => async () => {
    try {
      const value = await run();
      setPasted({ label, value });
      setNote(`pasted as ${label}`);
    } catch (err) {
      setPasted(null);
      setNote(`${label} failed: ${err.message}`);
    }
  };

  return (
    <box style={s.root}>
      <box style={s.left}>
        <box style={s.panel}>
          <text style={s.heading}>Copy</text>
          <Button
            label="plain text"
            onClick={copy('Hello, κόσμε! — from react-x11', 'plain text')}
          />
          <Button
            label="html + plain text"
            onClick={copy(
              {
                'text/html': '<b>Hello</b> from <i>react-x11</i>',
                'text/plain': 'Hello from react-x11',
              },
              'two flavours',
            )}
          />
          <Button
            label="a png"
            onClick={copy({ 'image/png': RED_DOT }, 'image/png')}
          />
          <Button
            label="this file, as a file list"
            onClick={copy(
              {
                'text/uri-list': `file://${process.cwd()}/examples/clipboard.jsx\r\n`,
              },
              'text/uri-list',
            )}
          />
          <Button
            label="clear it"
            onClick={async () => {
              await clipboard.clear();
              setNote('cleared');
            }}
          />
        </box>
      </box>

      <box style={s.col}>
        <box style={s.panel}>
          <text style={s.heading}>On the clipboard now</text>
          {offered.length === 0 ? (
            <text style={s.empty}>nothing, or nobody owns CLIPBOARD</text>
          ) : (
            offered.map((t) => (
              <text key={t} style={s.mono}>
                {t}
              </text>
            ))
          )}
          <Button label="refresh" onClick={refresh} />
        </box>

        <box style={s.panel}>
          <text style={s.heading}>Paste</text>
          <Button
            label="read('text')"
            onClick={paste('text', () => clipboard.read('text'))}
          />
          <Button
            label="readText()"
            onClick={paste('readText', () => clipboard.readText())}
          />
          <Button
            label="readFiles()"
            onClick={paste('files', async () =>
              (await clipboard.readFiles())
                .map((f) => f.path ?? f.uri)
                .join('\n'),
            )}
          />
          <Button
            label="read('image/png')"
            onClick={paste('png', async () => {
              const bytes = await clipboard.read('image/png');
              return bytes ? `${bytes.length} bytes` : null;
            })}
          />
          <text style={s.dim}>{note}</text>
          <text style={s.mono}>
            {pasted === null
              ? ''
              : pasted.value === null
                ? `${pasted.label}: (nothing of that kind)`
                : String(pasted.value).slice(0, 400)}
          </text>
        </box>
      </box>
    </box>
  );
}

function Inspector() {
  return (
    <window
      width={720}
      height={420}
      title="react-x11 — clipboard"
      style={{ backgroundColor: '#f5f6fa' }}
    >
      <App />
    </window>
  );
}

export default Inspector;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<Inspector />);
}

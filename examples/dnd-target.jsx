// Drag-and-drop, the target side. Run alongside the source half:
//
//   npm run examples:dnd-target     # terminal 1
//   npm run examples:dnd-source    # terminal 2  (needs an X server / DISPLAY)
//
// …then drag cards from the source window into the zones here — or drag
// files from a file manager, text from an editor, a link from a browser:
// each zone shows a different side of the drop API.
//
//   - "files only": dropAccept={['files']} — the semantic group matches
//     text/uri-list however the source spells it; e.files arrives parsed
//     (URIs percent-decoded, local paths extracted).
//   - "any text": dropAccept={['text']} catches the whole flavour zoo
//     (text/plain;charset=utf-8, UTF8_STRING, STRING…); e.text is the best
//     offered flavour.
//   - "demo objects": an exact custom MIME name plus `await e.getData()` —
//     JSON over the wire from another process, the live object by
//     reference (`e.items`) when dragged within one.
//
// Highlighting needs no state: the `:drag-over` style block does it. The
// files zone uses `useDropTarget` instead, to show `isOver`/`isAccepted`
// driving the render.
import React, { useState } from 'react';
import { createRoot, createStyles, useDropTarget } from '../src/index.js';

function FilesZone({ onLog }) {
  const { dropProps, isOver, isAccepted } = useDropTarget({
    accept: ['files'],
    onDrop: (e) => {
      for (const f of e.files) onLog(`file: ${f.path ?? f.uri}`);
    },
  });
  return (
    <box
      {...dropProps}
      style={[s.zone, isOver && (isAccepted ? s.zoneYes : s.zoneNo)]}
    >
      <text style={s.zoneTitle}>files only</text>
      <text style={s.zoneHint}>
        {isOver
          ? isAccepted
            ? 'drop them!'
            : 'not a file drag'
          : "dropAccept={['files']} — e.files, parsed"}
      </text>
    </box>
  );
}

function App() {
  const [log, setLog] = useState([]);
  const push = (line) =>
    setLog((l) => [
      ...l.slice(-7),
      `${new Date().toLocaleTimeString()}  ${line}`,
    ]);
  return (
    <window width={380} height={470} title="DnD target — drop on me">
      <box style={s.root}>
        <FilesZone onLog={push} />

        <box
          dropAccept={['text']}
          onDrop={(e) => push(`text: ${JSON.stringify(e.text ?? '')}`)}
          style={s.zone}
        >
          <text style={s.zoneTitle}>any text</text>
          <text style={s.zoneHint}>
            dropAccept={"{['text']}"} — utf-8, STRING, charset variants alike
          </text>
        </box>

        <box
          dropAccept={['application/x-react-x11-demo']}
          onDragOver={(e) => e.accept('move')}
          onDrop={async (e) => {
            // in-app: the live object; cross-process: JSON bytes
            const live = e.items?.['application/x-react-x11-demo'];
            if (live) return push(`demo object (live): ${live.name}`);
            const raw = await e.getData('application/x-react-x11-demo');
            const parsed = JSON.parse(String(raw));
            push(`demo object (wire): ${parsed.name}`);
          }}
          style={s.zone}
        >
          <text style={s.zoneTitle}>demo objects</text>
          <text style={s.zoneHint}>
            a custom MIME type — accepts the source example's cards, asks for
            'move'
          </text>
        </box>

        <box style={s.log}>
          <text style={s.logTitle}>drops</text>
          {log.length === 0 && <text style={s.logLine}>nothing yet…</text>}
          {log.map((line, i) => (
            <text key={i} style={s.logLine}>
              {line}
            </text>
          ))}
        </box>
      </box>
    </window>
  );
}

const s = createStyles({
  root: { flexGrow: 1, padding: 14, gap: 10, backgroundColor: '#f2f5f7' },
  zone: {
    padding: 12,
    gap: 3,
    borderWidth: 2,
    borderColor: '#c2ccd4',
    borderRadius: 8,
    backgroundColor: 'white',
    ':drag-over': { borderColor: '#4a7fb5', backgroundColor: '#eaf1f8' },
  },
  zoneYes: { borderColor: '#4a7fb5', backgroundColor: '#eaf1f8' },
  zoneNo: { borderColor: '#c25b4e', backgroundColor: '#f8eeec' },
  zoneTitle: { fontSize: 14, color: '#28313a' },
  zoneHint: { fontSize: 10, color: '#8a949c' },
  log: {
    flexGrow: 1,
    padding: 10,
    gap: 2,
    borderRadius: 8,
    backgroundColor: '#28313a',
  },
  logTitle: { fontSize: 11, color: '#8fa3b5' },
  logLine: { fontSize: 11, color: '#d5dde4' },
});

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<App />);
}

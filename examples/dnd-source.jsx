// Drag-and-drop, the source side. Run this together with the target half in
// a second terminal and drag between the two processes over XDND:
//
//   npm run examples:dnd-target     # terminal 1
//   npm run examples:dnd-source    # terminal 2  (needs an X server / DISPLAY)
//
// Three things are demonstrated here:
//   - the "file shelf": draggable cards whose dragData offers text/uri-list
//     (as a lazy thunk — resolved only if the drag actually leaves this
//     process), text/plain, and a custom application/x-react-x11-demo type
//     carrying JSON. Drop them on the target app, a file manager, an
//     editor, a terminal — anything XDND.
//   - in-app drags: the same cards drop onto the tray at the bottom of this
//     window; the payload arrives live (`e.items`, by reference, no
//     serialisation), and 'move' removes the card from the shelf.
//   - useDragSource: `isDragging` + `position` drive a live drag preview in
//     a `<popup dragPreview>` following the pointer — a React tree, not a
//     bitmap — and a `:dragging` style block dims the source card.
import React, { useState } from 'react';
import { createRoot, createStyles, useDragSource } from '../src/index.js';

const FILES = [
  { id: 'notes', name: 'notes.md', path: '/tmp/react-x11-demo/notes.md' },
  { id: 'photo', name: 'photo.png', path: '/tmp/react-x11-demo/photo.png' },
  { id: 'data', name: 'data.csv', path: '/tmp/react-x11-demo/data.csv' },
];

const toUri = (path) => `file://${encodeURI(path)}`;

function Card({ file, onMoved }) {
  const { dragProps, isDragging, position } = useDragSource({
    data: {
      // a thunk: never called unless the drag is promoted to XDND
      'text/uri-list': () => `${toUri(file.path)}\r\n`,
      'text/plain': file.path,
      // live for in-app drops; JSON.stringify'd automatically for the wire
      'application/x-react-x11-demo': file,
    },
    actions: ['copy', 'move'],
    onDragEnd: (e) => {
      if (e.action === 'move') onMoved(file.id);
    },
  });
  return (
    <>
      <box {...dragProps} style={s.card}>
        <text style={s.cardTitle}>{file.name}</text>
        <text style={s.cardPath}>{file.path}</text>
      </box>
      {isDragging && (
        <popup
          dragPreview
          x={position.x + 14}
          y={position.y + 14}
          width={180}
          height={34}
        >
          <box style={[s.preview, !position.accepted && s.previewNo]}>
            <text style={s.previewText}>
              {position.accepted ? '📄 ' : '🚫 '}
              {file.name}
            </text>
          </box>
        </popup>
      )}
    </>
  );
}

function App() {
  const [shelf, setShelf] = useState(FILES);
  const [tray, setTray] = useState([]);
  return (
    <window width={360} height={430} title="DnD source — drag out of me">
      <box style={s.root}>
        <text style={s.heading}>File shelf</text>
        <text style={s.hint}>
          Drag a card onto the target app (or any XDND application). Drop it on
          the tray below for an in-app move.
        </text>
        {shelf.map((file) => (
          <Card
            key={file.id}
            file={file}
            onMoved={(id) =>
              setShelf((list) => list.filter((f) => f.id !== id))
            }
          />
        ))}
        <box style={{ flexGrow: 1 }} />
        <box
          dropAccept={['application/x-react-x11-demo']}
          onDragOver={(e) => e.accept('move')}
          onDrop={(e) => {
            // internal transport: the object arrives by reference
            const file = e.items['application/x-react-x11-demo'];
            setTray((list) => [...list, file.name]);
          }}
          style={s.tray}
        >
          <text style={s.trayLabel}>
            {tray.length === 0
              ? 'in-app tray — drop here to move'
              : `moved here: ${tray.join(', ')}`}
          </text>
        </box>
      </box>
    </window>
  );
}

const s = createStyles({
  root: { flexGrow: 1, padding: 14, gap: 8, backgroundColor: '#f7f6f2' },
  heading: { fontSize: 18, color: '#333' },
  hint: { fontSize: 11, color: '#888' },
  card: {
    padding: 10,
    gap: 2,
    backgroundColor: 'white',
    borderWidth: 1,
    borderColor: '#d8d4cc',
    borderRadius: 6,
    ':hover': { borderColor: '#8a857b' },
    ':dragging': { backgroundColor: '#eceae4', borderColor: '#c4beb2' },
  },
  cardTitle: { fontSize: 14, color: '#222' },
  cardPath: { fontSize: 10, color: '#999' },
  preview: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingLeft: 10,
    backgroundColor: '#fffef8',
    borderWidth: 1,
    borderColor: '#b9b29f',
    borderRadius: 5,
  },
  previewNo: { borderColor: '#cc6659' },
  previewText: { fontSize: 12, color: '#444' },
  tray: {
    minHeight: 56,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#c9c3b6',
    borderRadius: 8,
    ':drag-over': { borderColor: '#7a9c59', backgroundColor: '#f0f4e8' },
  },
  trayLabel: { fontSize: 12, color: '#777' },
});

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<App />);
}

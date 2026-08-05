// Menus: a MenuBar of pull-down menus plus a ContextMenu on right-click —
// and, in the File menu, real file dialogs.
//
// Both render into <popup> — override-redirect X11 windows anchored with
// useAnchor, so they escape the owner window and flip at screen edges.
//
// Keyboard: click or Enter opens a bar menu, Left/Right walk the bar,
// Up/Down move within a menu (skipping separators and disabled entries),
// Right opens a submenu and Left leaves it, Enter picks, Escape closes one
// level at a time.
//
// **File → Open… is the real thing**, through `useFileDialog()`: the
// desktop's own dialog over xdg-desktop-portal where there is one,
// `NSOpenPanel` through `osascript` on a Mac, and a browser react-x11 draws
// itself everywhere else — ssh, a bare startx, a container. The window shows
// which rung this machine landed on; the menu code is the same either way,
// which is the whole point. See docs/filedialog.md.
//
// Run with: npm run examples:menu  (needs an X server / DISPLAY)
import React, { useEffect, useRef, useState } from 'react';
import {
  createRoot,
  ContextMenu,
  fileDialogBackend,
  MenuBar,
  useFileDialog,
} from '../src/index.js';

// Menu icons are SVG paths painted in `currentColor`, so one drawing serves
// every state a row can be in: the menu calls `icon` with the colour its
// label is being drawn in, and the icon puts it on the node as `color`. The
// renderer caches a single-colour drawing as *coverage* rather than pixels,
// so following the highlight is a composite and not a re-render, and every
// colour of an icon shares one rendered copy.
//
// `icon` also takes a plain string, which is a one-liner — but only as good
// as the font: `\u2702` and `\u23FB` are empty boxes in Arial, and a column
// of tofu is worse than no icons at all.
const svg = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">` +
  `<g fill="none" stroke="currentColor" stroke-width="1.25" ` +
  `stroke-linecap="round" stroke-linejoin="round">${body}</g></svg>`;

const icon =
  (source) =>
  ({ color, size }) => (
    <svg source={source} style={{ width: size, height: size, color }} />
  );

const ICONS = {
  page: icon(svg('<path d="M3 1.5h6l3 3v10H3z"/><path d="M9 1.5v3h3"/>')),
  folder: icon(svg('<path d="M1.5 13.5v-10h4l1.5 2h7.5v8z"/>')),
  save: icon(
    svg(
      '<path d="M8 1.5v8"/><path d="M5 6.5 8 9.5l3-3"/><path d="M2 13.5h12"/>',
    ),
  ),
  power: icon(svg('<path d="M8 1.5v6"/><path d="M4.6 3.9a5 5 0 1 0 6.8 0"/>')),
  undo: icon(
    svg(
      '<path d="M6 3.5 2.5 6.5 6 9.5"/><path d="M2.5 6.5h6a4 4 0 0 1 0 8H5"/>',
    ),
  ),
  redo: icon(
    svg(
      '<path d="m10 3.5 3.5 3-3.5 3"/><path d="M13.5 6.5h-6a4 4 0 0 0 0 8H11"/>',
    ),
  ),
  scissors: icon(
    svg(
      '<path d="M4 2 11 12"/><path d="M12 2 5 12"/>' +
        '<circle cx="4" cy="13" r="1.7"/><circle cx="12" cy="13" r="1.7"/>',
    ),
  ),
  copy: icon(
    svg(
      '<rect x="5.5" y="1.5" width="9" height="9" rx="1"/><path d="M10.5 13.5h-9v-9"/>',
    ),
  ),
  clipboard: icon(
    svg(
      '<rect x="2.5" y="2.5" width="11" height="12" rx="1"/>' +
        '<path d="M6 2.5V1.5h4v1z" fill="currentColor"/>',
    ),
  ),
  zoomIn: icon(
    svg(
      '<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3.5 3.5"/><path d="M5 7h4M7 5v4"/>',
    ),
  ),
  zoomOut: icon(
    svg(
      '<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3.5 3.5"/><path d="M5 7h4"/>',
    ),
  ),
};

function App() {
  const [last, setLast] = useState('(none)');
  const [wrap, setWrap] = useState(true);
  const note = (label) => () => setLast(label);

  // The File menu drives real dialogs. `parentWindow` is the one line worth
  // writing: it makes the dialog transient for this window, so the window
  // manager stacks it on top and the portal's own backend parents it the
  // same way. Without it the dialog floats, which is legal and looks
  // careless.
  const win = useRef(null);
  const { openFile, saveFile, selectFolder } = useFileDialog({
    parentWindow: win,
  });

  // Which rung this machine lands on — the desktop's own portal, macOS's
  // NSOpenPanel through `osascript`, or the browser react-x11 draws itself.
  // Shown because the whole point is that the app does not care.
  const [backend, setBackend] = useState('…');
  useEffect(() => {
    fileDialogBackend().then(setBackend, () => setBackend('unknown'));
  }, []);

  // Every one of these resolves to `null` when the user cancels — an
  // ordinary outcome, so none of them needs a `try`.
  const TEXT = [{ name: 'Text', extensions: ['txt', 'md'] }];
  const open = (options) => async () => {
    setLast('opening…');
    const files = await openFile({ filters: TEXT, ...options });
    setLast(files ? files.join(', ') : 'cancelled');
  };
  const save = () => async () => {
    setLast('saving…');
    const file = await saveFile({ filters: TEXT, defaultName: 'notes.md' });
    setLast(file ?? 'cancelled');
  };
  const folder = () => async () => {
    const dirs = await selectFolder();
    setLast(dirs ? dirs.join(', ') : 'cancelled');
  };

  // `icon` shares the check column, so it is a glyph rather than a picture:
  // a string is drawn as text in the font already in use. Pass a React
  // element instead — `<canvas onDraw>` — when it has to be a real drawing.
  const menus = [
    {
      label: 'File',
      items: [
        {
          label: 'New',
          icon: ICONS.page,
          shortcut: 'Ctrl+N',
          onSelect: note('New'),
        },
        {
          label: 'Open…',
          icon: ICONS.folder,
          shortcut: 'Ctrl+O',
          onSelect: open(),
        },
        {
          label: 'Open Files…',
          icon: ICONS.folder,
          onSelect: open({ multiple: true }),
        },
        {
          label: 'Open Folder…',
          icon: ICONS.folder,
          onSelect: folder(),
        },
        {
          // three levels: Open Recent → Projects → the file itself, which is
          // what a submenu's placement has to survive
          label: 'Open Recent',
          items: [
            {
              label: 'Projects',
              items: [
                { label: 'react-x11', onSelect: note('Recent → react-x11') },
                { label: 'ntk', onSelect: note('Recent → ntk') },
                { label: 'node-x11', onSelect: note('Recent → node-x11') },
              ],
            },
            {
              label: 'Documents',
              items: [
                { label: 'notes.md', onSelect: note('Recent → notes.md') },
                { label: 'todo.md', onSelect: note('Recent → todo.md') },
              ],
            },
            { separator: true },
            { label: 'Clear list', onSelect: note('Recent → clear') },
          ],
        },
        { separator: true },
        {
          label: 'Save',
          icon: ICONS.save,
          shortcut: 'Ctrl+S',
          onSelect: note('Save'),
        },
        { label: 'Save As…', icon: ICONS.save, onSelect: save() },
        {
          label: 'Export',
          items: [
            {
              label: 'Image',
              items: [
                { label: 'PNG', onSelect: note('Export → PNG') },
                { label: 'JPEG', onSelect: note('Export → JPEG') },
                { label: 'WebP', disabled: true },
              ],
            },
            {
              label: 'Vector',
              items: [
                { label: 'SVG', onSelect: note('Export → SVG') },
                { label: 'EPS', onSelect: note('Export → EPS') },
              ],
            },
            { separator: true },
            { label: 'PDF', disabled: true },
          ],
        },
        { separator: true },
        {
          label: 'Quit',
          icon: ICONS.power,
          shortcut: 'Ctrl+Q',
          onSelect: note('Quit'),
        },
      ],
    },
    {
      label: 'Edit',
      items: [
        {
          label: 'Undo',
          icon: ICONS.undo,
          shortcut: 'Ctrl+Z',
          onSelect: note('Undo'),
        },
        { label: 'Redo', icon: ICONS.redo, shortcut: 'Ctrl+Y', disabled: true },
        { separator: true },
        {
          label: 'Cut',
          icon: ICONS.scissors,
          shortcut: 'Ctrl+X',
          onSelect: note('Cut'),
        },
        {
          label: 'Copy',
          icon: ICONS.copy,
          shortcut: 'Ctrl+C',
          onSelect: note('Copy'),
        },
        {
          label: 'Paste',
          icon: ICONS.clipboard,
          shortcut: 'Ctrl+V',
          onSelect: note('Paste'),
        },
      ],
    },
    {
      label: 'View',
      items: [
        {
          // checked and iconned at once: the check wins, because the check
          // is state and the icon is only identity
          label: 'Wrap lines',
          icon: ICONS.page,
          checked: wrap,
          onSelect: () => {
            setWrap((w) => !w);
            setLast('Wrap lines');
          },
        },
        {
          label: 'Zoom in',
          icon: ICONS.zoomIn,
          shortcut: 'Ctrl++',
          onSelect: note('Zoom in'),
        },
        {
          label: 'Zoom out',
          icon: ICONS.zoomOut,
          shortcut: 'Ctrl+-',
          onSelect: note('Zoom out'),
        },
      ],
    },
  ];

  const contextItems = [
    {
      label: 'Cut',
      icon: ICONS.scissors,
      shortcut: 'Ctrl+X',
      onSelect: note('Cut (context)'),
    },
    {
      label: 'Copy',
      icon: ICONS.copy,
      shortcut: 'Ctrl+C',
      onSelect: note('Copy (context)'),
    },
    { label: 'Paste', icon: ICONS.clipboard, disabled: true },
    { separator: true },
    {
      label: 'Convert',
      items: [
        {
          label: 'Case',
          items: [
            { label: 'UPPER', onSelect: note('Convert → UPPER') },
            { label: 'lower', onSelect: note('Convert → lower') },
            { label: 'Title', onSelect: note('Convert → Title') },
          ],
        },
        { label: 'Tabs to spaces', onSelect: note('Convert → tabs') },
      ],
    },
    { separator: true },
    { label: 'Delete', icon: '\u2717', onSelect: note('Delete (context)') },
  ];

  return (
    <window
      ref={win}
      width={520}
      height={300}
      title="menus"
      style={{ backgroundColor: '#f5f6fa' }}
    >
      <box style={{ flexGrow: 1 }}>
        <MenuBar menus={menus} />
        <ContextMenu
          items={contextItems}
          style={{
            flexGrow: 1,
            justifyContent: 'center',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <text style={{ fontSize: 18, color: '#2d3436' }}>
            Right-click anywhere below the bar
          </text>
          <text style={{ color: '#7f8c8d' }}>
            last choice: <text style={{ color: '#2980b9' }}>{last}</text>
          </text>
          <text style={{ color: '#7f8c8d' }}>
            wrap lines: {wrap ? 'on' : 'off'}
          </text>
          <text style={{ color: '#7f8c8d' }}>
            File → Open/Save runs a real dialog, on this machine's{' '}
            <text style={{ color: '#2980b9' }}>{backend}</text> backend
          </text>
        </ContextMenu>
      </box>
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<App />);
}

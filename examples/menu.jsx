// Menus: a MenuBar of pull-down menus plus a ContextMenu on right-click.
// Both render into <popup> — override-redirect X11 windows anchored with
// useAnchor, so they escape the owner window and flip at screen edges.
//
// Keyboard: click or Enter opens a bar menu, Left/Right walk the bar,
// Up/Down move within a menu (skipping separators and disabled entries),
// Right opens a submenu and Left leaves it, Enter picks, Escape closes one
// level at a time.
//
// Run with: npm run examples:menu  (needs an X server / DISPLAY)
import React, { useState } from 'react';
import { createRoot, ContextMenu, MenuBar } from '../src/index.js';

function App() {
  const [last, setLast] = useState('(none)');
  const [wrap, setWrap] = useState(true);
  const note = (label) => () => setLast(label);

  const menus = [
    {
      label: 'File',
      items: [
        { label: 'New', shortcut: 'Ctrl+N', onSelect: note('New') },
        { label: 'Open…', shortcut: 'Ctrl+O', onSelect: note('Open…') },
        { separator: true },
        { label: 'Save', shortcut: 'Ctrl+S', onSelect: note('Save') },
        { label: 'Save As…', disabled: true },
        {
          label: 'Export',
          items: [
            { label: 'PNG image', onSelect: note('Export → PNG') },
            { label: 'SVG vector', onSelect: note('Export → SVG') },
            { separator: true },
            { label: 'PDF', disabled: true },
          ],
        },
        { separator: true },
        { label: 'Quit', shortcut: 'Ctrl+Q', onSelect: note('Quit') },
      ],
    },
    {
      label: 'Edit',
      items: [
        { label: 'Undo', shortcut: 'Ctrl+Z', onSelect: note('Undo') },
        { label: 'Redo', shortcut: 'Ctrl+Y', disabled: true },
        { separator: true },
        { label: 'Cut', shortcut: 'Ctrl+X', onSelect: note('Cut') },
        { label: 'Copy', shortcut: 'Ctrl+C', onSelect: note('Copy') },
        { label: 'Paste', shortcut: 'Ctrl+V', onSelect: note('Paste') },
      ],
    },
    {
      label: 'View',
      items: [
        {
          label: 'Wrap lines',
          checked: wrap,
          onSelect: () => {
            setWrap((w) => !w);
            setLast('Wrap lines');
          },
        },
        { label: 'Zoom in', shortcut: 'Ctrl++', onSelect: note('Zoom in') },
        { label: 'Zoom out', shortcut: 'Ctrl+-', onSelect: note('Zoom out') },
      ],
    },
  ];

  const contextItems = [
    { label: 'Cut', shortcut: 'Ctrl+X', onSelect: note('Cut (context)') },
    { label: 'Copy', shortcut: 'Ctrl+C', onSelect: note('Copy (context)') },
    { label: 'Paste', disabled: true },
    { separator: true },
    { label: 'Delete', onSelect: note('Delete (context)') },
  ];

  return (
    <window
      width={460}
      height={280}
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

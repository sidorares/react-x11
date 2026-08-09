export default {
  id: 'menu',
  title: 'Menus in real popup windows',
  description:
    'MenuBar and ContextMenu render into <popup> — override-redirect X ' +
    'windows at screen coordinates, so a menu escapes its owner window and ' +
    'flips at screen edges instead of being clipped. Submenus, keyboard ' +
    'navigation and type-ahead come with them.',
  code: `import React, { useState } from 'react';
import { createRoot, MenuBar, ContextMenu } from 'react-x11';

function App() {
  const [wrap, setWrap] = useState(true);
  const [last, setLast] = useState('nothing yet');

  const fileMenu = {
    label: 'File',
    items: [
      { label: 'New', shortcut: [['Control', 'N']], onSelect: () => setLast('New') },
      { label: 'Open…', shortcut: [['Control', 'O']], onSelect: () => setLast('Open') },
      { type: 'separator' },
      {
        label: 'Export',
        items: [
          { label: 'PNG', onSelect: () => setLast('Export PNG') },
          { label: 'SVG', onSelect: () => setLast('Export SVG') },
          { label: 'PDF', enabled: false },
        ],
      },
      { type: 'separator' },
      { label: 'Quit', shortcut: [['Control', 'Q']], onSelect: () => setLast('Quit') },
    ],
  };

  const viewMenu = {
    label: 'View',
    items: [
      {
        label: 'Wrap lines',
        toggleType: 'checkmark',
        toggleState: wrap ? 1 : 0,
        onSelect: () => setWrap(!wrap),
      },
      { label: 'Zoom in', shortcut: [['Control', 'plus']], onSelect: () => setLast('Zoom in') },
      { label: 'Zoom out', shortcut: [['Control', 'minus']], onSelect: () => setLast('Zoom out') },
    ],
  };

  const contextItems = [
    { label: 'Cut', onSelect: () => setLast('Cut') },
    { label: 'Copy', onSelect: () => setLast('Copy') },
    { label: 'Paste', enabled: false },
    { type: 'separator' },
    { label: 'Select all', onSelect: () => setLast('Select all') },
  ];

  return (
    <window x={30} y={30} width={560} height={380} title="menus"
            style={{ backgroundColor: '#f4f6f8' }}>

      <MenuBar menus={[fileMenu, viewMenu]} />

      <ContextMenu items={contextItems} style={{ flexGrow: 1 }}>
        <box style={{
          flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: 10,
        }}>
          <text style={{ fontSize: 16, color: '#1f2933' }}>
            right-click anywhere here
          </text>
          <text style={{ fontSize: 13, color: '#7b8794' }}>
            or use the menu bar — arrows, Home/End and type-ahead all work
          </text>
          <box style={{
            marginTop: 8,
            paddingLeft: 14, paddingRight: 14, paddingTop: 8, paddingBottom: 8,
            backgroundColor: '#ffffff', borderRadius: 6,
            borderWidth: 1, borderColor: '#d8dee4',
          }}>
            <text style={{ fontSize: 13 }}>last chosen: {last}</text>
          </box>
        </box>
      </ContextMenu>
    </window>
  );
}

const root = await createRoot();
root.render(<App />);
`,
};

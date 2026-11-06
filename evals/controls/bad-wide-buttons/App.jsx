// Control: stretched buttons. The good layout, but its actions are Buttons
// stacked in a column, where flexbox stretches each across the column: the
// trap AGENTS.md warns about, and a web form's look. Tokens, a menu bar and
// a minimum size, so only the buttons are wrong.
import React, { useState } from 'react';
import { Button, MenuBar, ThemeProvider } from 'react-x11';

const FILES = [
  ['Quarterly report.pages', 'Pages document', '2.4 MB', 'Today, 09:12'],
  ['Budget 2026.numbers', 'Numbers spreadsheet', '680 KB', 'Yesterday, 17:40'],
  ['Lease agreement.pdf', 'PDF document', '1.1 MB', '12 Oct 2026'],
  ['Meeting notes.md', 'Markdown text', '14 KB', '10 Oct 2026'],
  ['Tax return 2025.pdf', 'PDF document', '3.8 MB', '2 Oct 2026'],
  ['Wedding speech.docx', 'Word document', '42 KB', '28 Sep 2026'],
  ['Reading list.txt', 'Plain text', '3 KB', '21 Sep 2026'],
];

const row = {
  flexDirection: 'row',
  alignItems: 'center',
  gap: 8,
  height: 28,
  paddingInline: 12,
  ':hover': { backgroundColor: '$surfaceHover' },
};

export default function App() {
  const [selected, setSelected] = useState(FILES[0][0]);
  const menus = [
    {
      label: 'File',
      items: [
        { label: 'Open', shortcut: [['Control', 'O']], onSelect: () => {} },
      ],
    },
  ];
  return (
    <ThemeProvider value={{ fontSize: 13 }}>
      <window
        title="Files"
        width={880}
        height={540}
        minWidth={600}
        minHeight={360}
        style={{ backgroundColor: '$background' }}
      >
        <MenuBar menus={menus} />
        <box style={{ flexDirection: 'row', flexGrow: 1 }}>
          <box style={{ flexGrow: 1, flexBasis: 0 }}>
            {FILES.map(([name, kind, size]) => {
              const on = name === selected;
              return (
                <box
                  key={name}
                  role="option"
                  aria-label={name}
                  focusable
                  onClick={() => setSelected(name)}
                  style={[row, on && { backgroundColor: '$hoverBackground' }]}
                >
                  <text
                    style={{ flexGrow: 1, color: on ? '$hoverText' : '$text' }}
                  >
                    {name}
                  </text>
                  <text
                    style={{
                      width: 150,
                      color: on ? '$hoverText' : '$textMuted',
                    }}
                  >
                    {kind}
                  </text>
                  <text
                    style={{
                      width: 70,
                      textAlign: 'right',
                      color: on ? '$hoverText' : '$textMuted',
                    }}
                  >
                    {size}
                  </text>
                </box>
              );
            })}
          </box>
          <box
            style={{
              width: 300,
              padding: 16,
              gap: 10,
              borderStartWidth: 1,
              borderColor: '$border',
            }}
          >
            <text style={{ fontWeight: 600, color: '$text' }}>{selected}</text>
            <Button primary onPress={() => {}}>
              Open
            </Button>
            <Button onPress={() => {}}>Duplicate</Button>
            <Button onPress={() => {}}>Rename</Button>
            <Button onPress={() => {}}>Move to Trash</Button>
          </box>
        </box>
      </window>
    </ThemeProvider>
  );
}

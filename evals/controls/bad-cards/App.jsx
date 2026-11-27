// Control: card soup. The same files, each one a rounded, shadowed, padded
// card in a grid on a grey page, which is how a web dashboard lists things
// and not how a desktop file browser does. Theme tokens throughout, a menu
// bar and a minimum size, so only the look is wrong.
import React, { useState } from 'react';
import { MenuBar, ThemeProvider } from 'react-x11';

const PLACES = {
  Documents: [
    ['Quarterly report.pages', 'Pages document', '2.4 MB', 'Today, 09:12'],
    [
      'Budget 2026.numbers',
      'Numbers spreadsheet',
      '680 KB',
      'Yesterday, 17:40',
    ],
    ['Lease agreement.pdf', 'PDF document', '1.1 MB', '12 Oct 2026'],
    ['Meeting notes.md', 'Markdown text', '14 KB', '10 Oct 2026'],
    ['Tax return 2025.pdf', 'PDF document', '3.8 MB', '2 Oct 2026'],
    ['Wedding speech.docx', 'Word document', '42 KB', '28 Sep 2026'],
  ],
  Downloads: [
    ['node-v24.19.0.pkg', 'Installer package', '71 MB', 'Today, 08:03'],
    ['boarding-pass-QF401.pdf', 'PDF document', '210 KB', 'Yesterday, 21:15'],
  ],
  Desktop: [['todo.txt', 'Plain text', '1 KB', '20 Oct 2026']],
};

const card = {
  width: 200,
  padding: 16,
  gap: 6,
  borderRadius: 16,
  backgroundColor: '$background',
  boxShadow: '0 6px 18px $border',
};

export default function App() {
  const [place, setPlace] = useState('Documents');
  const menus = [
    {
      label: 'File',
      items: [
        { label: 'Open', shortcut: [['Control', 'O']], onSelect: () => {} },
      ],
    },
    {
      label: 'View',
      items: Object.keys(PLACES).map((p) => ({
        label: p,
        onSelect: () => setPlace(p),
      })),
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
      >
        <MenuBar menus={menus} />
        <box
          style={{
            flexGrow: 1,
            backgroundColor: '$surface',
            padding: 24,
            gap: 20,
          }}
        >
          <box style={{ flexDirection: 'row', gap: 12 }}>
            {Object.keys(PLACES).map((p) => (
              <box
                key={p}
                role="tab"
                aria-label={p}
                focusable
                onClick={() => setPlace(p)}
                style={{
                  paddingInline: 18,
                  paddingBlock: 8,
                  borderRadius: 20,
                  backgroundColor: p === place ? '$accent' : '$background',
                  boxShadow: '0 2px 8px $border',
                }}
              >
                <text
                  style={{
                    color: p === place ? '$accentText' : '$text',
                    fontWeight: 600,
                  }}
                >
                  {p}
                </text>
              </box>
            ))}
          </box>
          <box
            style={{
              flexDirection: 'row',
              flexWrap: 'wrap',
              gap: 20,
              overflow: 'scroll',
              flexGrow: 1,
            }}
          >
            {PLACES[place].map(([name, kind, size, date]) => (
              <box key={name} style={card} role="listitem" aria-label={name}>
                <text style={{ fontWeight: 600, color: '$text', fontSize: 15 }}>
                  {name}
                </text>
                <text style={{ color: '$textMuted' }}>{kind}</text>
                <text
                  style={{ color: '$textMuted' }}
                >{`${size} · ${date}`}</text>
              </box>
            ))}
          </box>
        </box>
      </window>
    </ThemeProvider>
  );
}

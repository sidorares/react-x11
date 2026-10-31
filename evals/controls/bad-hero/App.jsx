// Control: a hero header. A gradient banner with a big title and a tagline
// above a centred column of files, which is a landing page in a window.
// Tokens, a menu bar and a minimum size, so only the look is wrong.
import React, { useState } from 'react';
import { MenuBar, ThemeProvider } from 'react-x11';

const FILES = [
  ['Quarterly report.pages', 'Pages document', '2.4 MB'],
  ['Budget 2026.numbers', 'Numbers spreadsheet', '680 KB'],
  ['Lease agreement.pdf', 'PDF document', '1.1 MB'],
  ['Meeting notes.md', 'Markdown text', '14 KB'],
  ['Tax return 2025.pdf', 'PDF document', '3.8 MB'],
];

export default function App() {
  const [query, setQuery] = useState('');
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
        <box style={{ flexGrow: 1, overflow: 'scroll' }}>
          <box
            style={{
              alignItems: 'center',
              paddingBlock: 40,
              gap: 10,
              backgroundImage: 'linear-gradient(135deg, $accent, $info)',
            }}
          >
            <text
              style={{ fontSize: 34, fontWeight: 700, color: '$accentText' }}
            >
              Welcome to Files
            </text>
            <text style={{ fontSize: 16, color: '$accentText' }}>
              All your documents, beautifully organised.
            </text>
          </box>
          <box
            style={{
              alignSelf: 'center',
              width: 460,
              paddingBlock: 24,
              gap: 12,
            }}
          >
            <textinput
              placeholder="Search your files…"
              aria-label="Search"
              value={query}
              onChange={(ev) => setQuery(ev.value)}
            />
            {FILES.filter(([n]) =>
              n.toLowerCase().includes(query.toLowerCase()),
            ).map(([name, kind, size]) => (
              <box
                key={name}
                role="option"
                aria-label={name}
                focusable
                style={{ flexDirection: 'row', paddingBlock: 6 }}
              >
                <text style={{ flexGrow: 1, color: '$text' }}>{name}</text>
                <text
                  style={{ color: '$textMuted' }}
                >{`${kind} · ${size}`}</text>
              </box>
            ))}
          </box>
        </box>
      </window>
    </ThemeProvider>
  );
}

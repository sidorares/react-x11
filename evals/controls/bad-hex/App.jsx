// Control: hard-coded colours. The good file browser with its theme tokens
// swapped for a light palette of its own: right in light, wrong in dark,
// and blind to the user's accent.
import React, { useMemo, useState } from 'react';
import {
  Button,
  ContextMenu,
  Icon,
  MenuBar,
  ThemeProvider,
  createStyles,
} from 'react-x11';

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
    ['Reading list.txt', 'Plain text', '3 KB', '21 Sep 2026'],
    ['Insurance claim.pdf', 'PDF document', '920 KB', '14 Sep 2026'],
  ],
  Downloads: [
    ['node-v24.19.0.pkg', 'Installer package', '71 MB', 'Today, 08:03'],
    ['boarding-pass-QF401.pdf', 'PDF document', '210 KB', 'Yesterday, 21:15'],
    ['IMG_2041.HEIC', 'HEIF image', '3.2 MB', '19 Oct 2026'],
    ['invoice-3381.pdf', 'PDF document', '88 KB', '17 Oct 2026'],
  ],
  Desktop: [
    [
      'Screenshot 2026-10-21 at 14.02.png',
      'PNG image',
      '1.6 MB',
      'Yesterday, 14:02',
    ],
    ['todo.txt', 'Plain text', '1 KB', '20 Oct 2026'],
  ],
  Pictures: [
    ['Melbourne trip', 'Folder', '—', '11 Oct 2026'],
    ['Family 2025', 'Folder', '—', '3 Jan 2026'],
    ['avatar.jpg', 'JPEG image', '240 KB', '9 Aug 2026'],
  ],
};

const s = createStyles({
  root: { flexDirection: 'row', flexGrow: 1 },
  sidebar: {
    width: 200,
    paddingTop: 10,
    paddingInline: 8,
    gap: 2,
    backgroundColor: '#f5f5f7',
    borderEndWidth: 1,
    borderColor: '#d2d2d7',
  },
  head: {
    fontSize: 11,
    fontWeight: 600,
    color: '#86868b',
    paddingStart: 8,
    paddingBottom: 4,
  },
  place: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 28,
    paddingInline: 8,
    borderRadius: 6,
    cursor: 'pointer',
    ':hover': { backgroundColor: '#ebebf0' },
  },
  placeOn: {
    backgroundColor: '#0a84ff',
    ':hover': { backgroundColor: '#0a84ff' },
  },
  placeName: { color: '#1d1d1f' },
  onSelection: { color: '#ffffff' },
  main: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 44,
    paddingInline: 12,
    borderBottomWidth: 1,
    borderColor: '#d2d2d7',
  },
  title: { fontWeight: 600, color: '#1d1d1f', flexGrow: 1 },
  search: { width: 180 },
  header: {
    flexDirection: 'row',
    height: 26,
    alignItems: 'center',
    paddingInline: 12,
    gap: 8,
    borderBottomWidth: 1,
    borderColor: '#d2d2d7',
  },
  headText: { fontSize: 11, color: '#86868b' },
  listing: { flexGrow: 1, overflow: 'scroll' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 28,
    paddingInline: 12,
    ':hover': { backgroundColor: '#ebebf0' },
  },
  rowOn: {
    backgroundColor: '#0a84ff',
    ':hover': { backgroundColor: '#0a84ff' },
  },
  name: {
    flexGrow: 1,
    flexBasis: 0,
    color: '#1d1d1f',
    textWrap: 'nowrap',
    textOverflow: 'ellipsis',
  },
  kind: {
    width: 150,
    color: '#86868b',
    textWrap: 'nowrap',
    textOverflow: 'ellipsis',
  },
  size: {
    width: 70,
    color: '#86868b',
    textAlign: 'right',
    fontVariantNumeric: 'tabular-nums',
  },
  date: { width: 130, color: '#86868b', textWrap: 'nowrap' },
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 28,
    paddingInline: 12,
    borderTopWidth: 1,
    borderColor: '#d2d2d7',
  },
  statusText: { fontSize: 11, color: '#86868b' },
});

export default function App() {
  const [place, setPlace] = useState('Documents');
  const [selected, setSelected] = useState('Quarterly report.pages');
  const [query, setQuery] = useState('');
  const files = useMemo(
    () =>
      PLACES[place].filter(([name]) =>
        name.toLowerCase().includes(query.toLowerCase()),
      ),
    [place, query],
  );
  const menus = [
    {
      label: 'File',
      items: [
        {
          label: 'New Folder',
          shortcut: [['Control', 'Shift', 'N']],
          onSelect: () => {},
        },
        {
          label: 'Open',
          shortcut: [['Control', 'O']],
          enabled: Boolean(selected),
          onSelect: () => {},
        },
        { type: 'separator' },
        {
          label: 'Move to Trash',
          shortcut: [['Control', 'BackSpace']],
          enabled: Boolean(selected),
          onSelect: () => {},
        },
      ],
    },
    {
      label: 'View',
      items: Object.keys(PLACES).map((p, i) => ({
        label: p,
        shortcut: [['Control', String(i + 1)]],
        onSelect: () => setPlace(p),
      })),
    },
    { label: 'Help', items: [{ label: 'Files Help', onSelect: () => {} }] },
  ];
  return (
    <ThemeProvider value={{ fontSize: 13 }}>
      <window
        title="Files"
        width={880}
        height={540}
        minWidth={600}
        minHeight={360}
        style={{ backgroundColor: '#ffffff' }}
      >
        <MenuBar menus={menus} />
        <box style={s.root}>
          <box style={s.sidebar} role="listbox" aria-label="Places">
            <text style={s.head}>Favourites</text>
            {Object.keys(PLACES).map((p) => (
              <box
                key={p}
                style={[s.place, p === place && s.placeOn]}
                role="option"
                aria-label={p}
                aria-selected={p === place}
                focusable
                onClick={() => {
                  setPlace(p);
                  setSelected(null);
                }}
              >
                <text style={[s.placeName, p === place && s.onSelection]}>
                  {p}
                </text>
              </box>
            ))}
          </box>
          <box style={s.main}>
            <box style={s.toolbar}>
              <text style={s.title}>{place}</text>
              <Button
                variant="ghost"
                size="small"
                aria-label="New Folder"
                onPress={() => {}}
              >
                <Icon name="plus" />
              </Button>
              <textinput
                style={s.search}
                placeholder="Search"
                aria-label="Search"
                value={query}
                onChange={(ev) => setQuery(ev.value)}
              />
            </box>
            <box style={s.header}>
              <text style={[s.headText, { flexGrow: 1, flexBasis: 0 }]}>
                Name
              </text>
              <text style={[s.headText, { width: 150 }]}>Kind</text>
              <text style={[s.headText, { width: 70, textAlign: 'right' }]}>
                Size
              </text>
              <text style={[s.headText, { width: 130 }]}>Date Modified</text>
            </box>
            <ContextMenu
              items={[
                { label: 'Open', onSelect: () => {} },
                { label: 'Move to Trash', onSelect: () => {} },
              ]}
              style={{ flexGrow: 1 }}
            >
              <box style={s.listing} role="listbox" aria-label="Files">
                {files.map(([name, kind, size, date]) => {
                  const on = name === selected;
                  return (
                    <box
                      key={name}
                      style={[s.row, on && s.rowOn]}
                      role="option"
                      aria-label={name}
                      aria-selected={on}
                      focusable
                      onClick={() => setSelected(name)}
                    >
                      <text style={[s.name, on && s.onSelection]}>{name}</text>
                      <text style={[s.kind, on && s.onSelection]}>{kind}</text>
                      <text style={[s.size, on && s.onSelection]}>{size}</text>
                      <text style={[s.date, on && s.onSelection]}>{date}</text>
                    </box>
                  );
                })}
              </box>
            </ContextMenu>
            <box style={s.status}>
              <text
                style={s.statusText}
              >{`${files.length} items${selected ? ', 1 selected' : ''}`}</text>
            </box>
          </box>
        </box>
      </window>
    </ThemeProvider>
  );
}

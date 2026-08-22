// The showcase: one window that hosts the other examples as tabs, laid out
// with the two container controls an application needs before anything else.
//
//   SplitPane  — a sidebar you can drag wider, with a vertical Tabs strip
//                in it and the selected panel filling the rest
//   Tabs       — one panel visible at a time, arrows to move between them
//
// Each panel is imported from the example that owns it, so this file adds a
// layout and nothing else: examples/form.jsx and friends still run on their
// own with `npm run examples:form`.
// Run with: npm run examples:app  (needs an X server / DISPLAY)
import React, { useState } from 'react';
import {
  createRoot,
  createStyles,
  SplitPane,
  Table,
  Tabs,
} from '../src/index.js';
import { FormPanel } from './form.jsx';
import { WidgetsPanel } from './widgets.jsx';
import { PasswordPanel } from './password.jsx';
import { TasksPanel } from './tasks.jsx';
import { ThemingPanel } from './theming.jsx';

const s = createStyles({
  window: { backgroundColor: '$surfaceHover' },
  sidebar: {
    flexGrow: 1,
    backgroundColor: '$surface',
    paddingTop: 12,
    paddingBottom: 12,
  },
  title: {
    fontSize: 15,
    color: '$text',
    paddingLeft: 12,
    paddingRight: 12,
    paddingBottom: 8,
  },
  hint: {
    fontSize: 11,
    color: '$textMuted',
    paddingLeft: 12,
    paddingRight: 12,
  },
  spacer: { flexGrow: 1 },
  content: {
    flexGrow: 1,
    minHeight: 0,
    minWidth: 0,
    backgroundColor: '$background',
  },
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 12,
    paddingRight: 12,
    height: 24,
    flexShrink: 0,
    backgroundColor: '$background',
  },
  statusText: { fontSize: 11, color: '$textMuted' },
  panelBox: { flexGrow: 1, minHeight: 0, padding: 12, gap: 8 },
  panelHint: { fontSize: 11, color: '$textMuted', flexShrink: 0 },
});

// The strip lives in the sidebar and the panel on the other side of the
// divider, so Tabs is used here purely as the navigator: give it items with
// no `content` and it renders the strip alone. (Hand it `content` instead
// and it owns the panel too — see docs/components.md.)
const SECTIONS = [
  { id: 'form', label: 'Form' },
  { id: 'widgets', label: 'Widgets' },
  { id: 'password', label: 'Password' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'table', label: 'Table' },
  { id: 'theming', label: 'Theming' },
];

// A stand-in project, enough to show nesting, a lazy-looking empty branch
// and a row that cannot be opened.

// Enough rows that building them all would be silly — the table mounts the
// twenty or so on screen and swaps them as you scroll.
const ROWS = Array.from({ length: 10000 }, (_, i) => ({
  id: i,
  name: `file-${String(i).padStart(5, '0')}.js`,
  kind: ['source', 'test', 'doc', 'asset'][i % 4],
  size: (i * 37) % 4096,
  modified: `2026-07-${String((i % 28) + 1).padStart(2, '0')}`,
}));

const COLUMNS = [
  { id: 'name', label: 'Name', width: 200 },
  { id: 'kind', label: 'Kind', width: 90 },
  { id: 'size', label: 'Size', width: 90, align: 'right' },
  { id: 'modified', label: 'Modified', width: 120 },
];

function TablePanel() {
  const [picked, setPicked] = useState(null);
  return (
    <box style={s.panelBox}>
      <text style={s.panelHint}>
        {ROWS.length.toLocaleString()} rows — drag a header edge to resize,
        click one to sort
      </text>
      <Table
        columns={COLUMNS}
        rows={ROWS}
        selected={picked}
        onSelect={setPicked}
        style={{ flexGrow: 1 }}
      />
      <text style={s.panelHint}>
        {picked == null ? 'nothing selected' : `selected: ${ROWS[picked].name}`}
      </text>
    </box>
  );
}

const PANELS = {
  form: () => <FormPanel />,
  widgets: () => <WidgetsPanel />,
  password: () => <PasswordPanel />,
  tasks: () => <TasksPanel />,
  table: () => <TablePanel />,
  theming: () => <ThemingPanel />,
};

function App() {
  const [section, setSection] = useState('form');
  const [sidebar, setSidebar] = useState(150);
  const active = SECTIONS.find((item) => item.id === section);

  return (
    <window
      title="react-x11"
      width={720}
      height={520}
      minWidth={420}
      minHeight={320}
      style={s.window}
    >
      <SplitPane
        direction="row"
        size={sidebar}
        onResize={setSidebar}
        min={110}
        minSecond={260}
      >
        <box style={s.sidebar}>
          <text style={s.title}>Examples</text>
          {/* the strip is the navigator: one panel at a time, and the
              panels are built lazily so switching does not pay for the
              ones nobody is looking at */}
          <Tabs
            orientation="vertical"
            items={SECTIONS}
            value={section}
            onChange={setSection}
            style={{ flexGrow: 0 }}
          />
          <box style={s.spacer} />
          <text style={s.hint}>Up/Down to switch{'\n'}drag the edge →</text>
        </box>

        <box style={s.content}>
          <box style={s.status}>
            <text style={s.statusText}>
              {active?.label} — sidebar {String(sidebar)}px
            </text>
          </box>
          {PANELS[section]?.()}
        </box>
      </SplitPane>
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<App />);
}

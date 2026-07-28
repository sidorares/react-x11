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
  Tabs,
  Tree,
} from '../src/index.js';
import { FormPanel } from './form.jsx';
import { WidgetsPanel } from './widgets.jsx';
import { TasksPanel } from './tasks.jsx';

const PALETTE = {
  bg: '#f5f6fa',
  panel: '#ffffff',
  text: '#2d3436',
  dim: '#7f8c8d',
  edge: '#dfe6e9',
};

const s = createStyles({
  window: { backgroundColor: '$bg' },
  sidebar: {
    flexGrow: 1,
    backgroundColor: '$panel',
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
  hint: { fontSize: 11, color: '$dim', paddingLeft: 12, paddingRight: 12 },
  spacer: { flexGrow: 1 },
  content: {
    flexGrow: 1,
    minHeight: 0,
    minWidth: 0,
    backgroundColor: '$panel',
  },
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 12,
    paddingRight: 12,
    height: 24,
    flexShrink: 0,
    backgroundColor: '$panel',
  },
  statusText: { fontSize: 11, color: '$dim' },
  treePanel: { flexGrow: 1, minHeight: 0, padding: 12, gap: 8 },
  treeHint: { fontSize: 11, color: '$dim', flexShrink: 0 },
});

// The strip lives in the sidebar and the panel on the other side of the
// divider, so Tabs is used here purely as the navigator: give it items with
// no `content` and it renders the strip alone. (Hand it `content` instead
// and it owns the panel too — see docs/components.md.)
const SECTIONS = [
  { id: 'form', label: 'Form' },
  { id: 'widgets', label: 'Widgets' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'tree', label: 'Tree' },
];

// A stand-in project, enough to show nesting, a lazy-looking empty branch
// and a row that cannot be opened.
const FILES = [
  {
    id: 'src',
    label: 'src',
    children: [
      { id: 'index', label: 'index.js' },
      { id: 'nodes', label: 'nodes.js' },
      {
        id: 'components',
        label: 'components',
        children: [
          { id: 'button', label: 'Button.js' },
          { id: 'tabs', label: 'Tabs.js' },
          { id: 'tree', label: 'Tree.js' },
        ],
      },
    ],
  },
  {
    id: 'docs',
    label: 'docs',
    children: [
      { id: 'elements', label: 'elements.md' },
      { id: 'styling', label: 'styling.md' },
      { id: 'img', label: 'img', children: [] },
    ],
  },
  { id: 'readme', label: 'README.md' },
  { id: 'lock', label: 'package-lock.json', disabled: true },
];

function TreePanel() {
  const [picked, setPicked] = useState('nodes');
  return (
    <box style={s.treePanel}>
      <text style={s.treeHint}>
        Arrows to walk, Right/Left to open and close, type a name
      </text>
      <Tree
        items={FILES}
        defaultExpanded={['src', 'docs']}
        selected={picked}
        onSelect={setPicked}
        style={{ flexGrow: 1 }}
      />
      <text style={s.treeHint}>selected: {picked}</text>
    </box>
  );
}

const PANELS = {
  form: () => <FormPanel />,
  widgets: () => <WidgetsPanel />,
  tasks: () => <TasksPanel />,
  tree: () => <TreePanel />,
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
      theme={PALETTE}
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

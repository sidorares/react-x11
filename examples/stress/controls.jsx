// Interactive components, packed densely and with the awkward combinations
// on purpose: a text field inside a scrollview inside a split pane, a menu
// that has to escape its owner window, a dialog over the top of all of it.
//
// What to look for:
//   - Tab walking focus in visual order, and the focus ring visible on each
//   - a scrollview inside a scrollview scrolling the *inner* one under the
//     pointer, and the outer one only when the inner is at its end
//   - the context menu and tooltips appearing outside the window edge when
//     the window is dragged near the screen border
//   - typing in the field inside the nested scrollview, with the caret
//     staying visible as it scrolls
//   - right-clicking the text field giving the *edit* menu (cut/copy/paste),
//     not this panel's menu
import React, { useState } from 'react';
import {
  Button,
  Checkbox,
  ContextMenu,
  createStyles,
  Dialog,
  MenuBar,
  ProgressBar,
  Radio,
  RadioGroup,
  Select,
  Slider,
  SplitPane,
  Switch,
  Tooltip,
  Tree,
} from '../../src/index.js';

const s = createStyles({
  panel: { flexGrow: 1, minHeight: 0 },
  body: { flexGrow: 1, minHeight: 0, padding: 12, gap: 10 },
  head: { fontSize: 16, color: '#2d3436' },
  hint: { fontSize: 11, color: '#7f8c8d' },
  card: {
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#dfe6e9',
    borderRadius: 4,
    padding: 10,
    gap: 8,
  },
  title: { fontSize: 12, color: '#2d3436' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  // A row of things sized by their own text — buttons, chips — has to wrap.
  // Yoga defaults flexShrink to 0, so without this they do not compress to
  // fit, they overflow: three buttons that sit comfortably in a 250px card in
  // one font run off the edge of it in a wider one. Anything laid out against
  // the metrics of the font you happened to test with is a latent bug, and a
  // desktop app cannot know the metrics in advance.
  buttonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flexWrap: 'wrap',
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  label: { fontSize: 11, color: '#7f8c8d', width: 74 },
  inner: {
    height: 120,
    borderWidth: 1,
    borderColor: '#dfe6e9',
    borderRadius: 3,
    padding: 6,
    gap: 6,
  },
});

const FRUIT = [
  { value: 'apple', label: 'Apple' },
  { value: 'apricot', label: 'Apricot' },
  { value: 'banana', label: 'Banana' },
  { value: 'carrot', label: 'Carrot' },
  { value: 'cherry', label: 'Cherry' },
  { value: 'damson', label: 'Damson' },
];

const OUTLINE = [
  {
    id: 'a',
    label: 'Chapter one',
    children: [
      { id: 'a1', label: 'Section 1.1' },
      {
        id: 'a2',
        label: 'Section 1.2',
        children: [
          { id: 'a2a', label: 'Deeply nested' },
          { id: 'a2b', label: 'Also nested' },
        ],
      },
    ],
  },
  { id: 'b', label: 'Chapter two', children: [] },
  { id: 'c', label: 'Appendix', disabled: true },
];

export function ControlsPanel() {
  const [checks, setChecks] = useState({ one: true, two: false, three: false });
  const [radio, setRadio] = useState('b');
  const [toggle, setToggle] = useState(true);
  const [fruit, setFruit] = useState('cherry');
  const [level, setLevel] = useState(55);
  const [presses, setPresses] = useState(0);
  const [dialog, setDialog] = useState(false);
  const [note, setNote] = useState('Right-click me for the edit menu.');
  const [longText, setLongText] = useState(
    'A textarea with several lines of content\nso the caret can be walked\nup and down between them.',
  );
  const [picked, setPicked] = useState('a1');
  const [split, setSplit] = useState(220);
  const [lastMenu, setLastMenu] = useState('—');

  const menuItems = [
    { label: 'Cut', shortcut: 'Ctrl+X', onSelect: () => setLastMenu('Cut') },
    { label: 'Copy', shortcut: 'Ctrl+C', onSelect: () => setLastMenu('Copy') },
    { separator: true },
    {
      label: 'Transform',
      items: [
        { label: 'Uppercase', onSelect: () => setLastMenu('Uppercase') },
        { label: 'Lowercase', onSelect: () => setLastMenu('Lowercase') },
        {
          label: 'More',
          items: [
            { label: 'Reverse', onSelect: () => setLastMenu('Reverse') },
            { label: 'Shuffle', onSelect: () => setLastMenu('Shuffle') },
          ],
        },
      ],
    },
    { separator: true },
    { label: 'Disabled row', disabled: true },
    {
      label: 'Checked row',
      checked: toggle,
      onSelect: () => setToggle((v) => !v),
    },
  ];

  return (
    <box style={s.panel}>
      <MenuBar
        menus={[
          {
            label: 'File',
            items: [
              {
                label: 'New',
                shortcut: 'Ctrl+N',
                onSelect: () => setLastMenu('New'),
              },
              { label: 'Open…', onSelect: () => setLastMenu('Open') },
              { separator: true },
              { label: 'Save As…', disabled: true },
            ],
          },
          {
            label: 'Edit',
            items: [
              {
                label: 'Undo',
                shortcut: 'Ctrl+Z',
                onSelect: () => setLastMenu('Undo'),
              },
              { separator: true },
              {
                label: 'Wrap lines',
                checked: toggle,
                onSelect: () => setToggle((v) => !v),
              },
            ],
          },
          {
            label: 'View',
            items: [
              { label: 'Zoom in', onSelect: () => setLastMenu('Zoom in') },
              { label: 'Zoom out', onSelect: () => setLastMenu('Zoom out') },
            ],
          },
        ]}
      />

      {/* A split pane inside a tab panel: the divider drag has to work while
          the panel itself is being sized by the tab strip's layout. */}
      <SplitPane
        direction="row"
        size={split}
        onResize={setSplit}
        min={160}
        minSecond={280}
        style={{ flexGrow: 1, minHeight: 0 }}
      >
        <box style={{ ...s.body, gap: 8 }}>
          <text style={s.head}>Outline</text>
          <Tree
            items={OUTLINE}
            defaultExpanded={['a', 'a2']}
            selected={picked}
            onSelect={setPicked}
            style={{ flexGrow: 1 }}
          />
          <text style={s.hint}>selected: {picked}</text>
        </box>

        <scrollview style={s.body}>
          <text style={s.head}>Controls</text>
          <text style={s.hint}>
            last menu action: {lastMenu} · presses: {String(presses)}
          </text>

          <box style={s.grid}>
            <box style={{ ...s.card, width: 250 }}>
              <text style={s.title}>Toggles</text>
              {['one', 'two', 'three'].map((key) => (
                <Checkbox
                  key={key}
                  checked={checks[key]}
                  onChange={(v) => setChecks((c) => ({ ...c, [key]: v }))}
                  label={`Checkbox ${key}`}
                />
              ))}
              <box style={s.row}>
                <text style={s.label}>Switch</text>
                <Switch checked={toggle} onChange={setToggle} />
              </box>
              <RadioGroup value={radio} onChange={setRadio}>
                <Radio value="a" label="Option A" />
                <Radio value="b" label="Option B" />
                <Radio value="c" label="Option C (disabled)" disabled />
              </RadioGroup>
            </box>

            <box style={{ ...s.card, width: 250 }}>
              <text style={s.title}>Values</text>
              <box style={s.row}>
                <text style={s.label}>Select</text>
                <Select
                  options={FRUIT}
                  value={fruit}
                  onChange={setFruit}
                  style={{ flexGrow: 1 }}
                />
              </box>
              <box style={s.row}>
                <text style={s.label}>Slider</text>
                <Slider
                  value={level}
                  min={0}
                  max={100}
                  onChange={setLevel}
                  style={{ flexGrow: 1 }}
                />
                <text style={s.hint}>{String(level)}</text>
              </box>
              <box style={s.row}>
                <text style={s.label}>Progress</text>
                <ProgressBar value={level / 100} style={{ flexGrow: 1 }} />
              </box>
              <box style={s.buttonRow}>
                <Tooltip label="Counts presses, nothing more">
                  <Button primary onPress={() => setPresses((n) => n + 1)}>
                    Press me
                  </Button>
                </Tooltip>
                <Button onPress={() => setDialog(true)}>Dialog…</Button>
                <Button disabled>Disabled</Button>
              </box>
            </box>

            <box style={{ ...s.card, width: 250 }}>
              <text style={s.title}>Text entry</text>
              <textinput
                value={note}
                onChange={setNote}
                placeholder="single line"
                style={{ width: '100%' }}
              />
              <textarea
                value={longText}
                onChange={setLongText}
                rows={4}
                style={{ width: '100%' }}
              />
              <text style={s.hint}>
                {note.length} chars · {longText.split('\n').length} lines
              </text>
            </box>

            {/* A scrollview inside a scrollview: the wheel should reach the
                inner one first, and only fall through when it is at its end. */}
            <box style={{ ...s.card, width: 250 }}>
              <text style={s.title}>Nested scroll</text>
              <scrollview style={s.inner}>
                {Array.from({ length: 20 }, (_, i) => (
                  <box key={i} style={s.row}>
                    <text style={{ fontSize: 11, color: '#7f8c8d' }}>
                      row {String(i).padStart(2, '0')}
                    </text>
                    <textinput
                      value={`field ${i}`}
                      style={{ flexGrow: 1, fontSize: 11 }}
                    />
                  </box>
                ))}
              </scrollview>
              <text style={s.hint}>wheel inside, then past the end</text>
            </box>

            <ContextMenu
              items={menuItems}
              onSelect={(item) => setLastMenu(item.label)}
              style={{ ...s.card, width: 250, height: 110 }}
            >
              <text style={s.title}>Context menu</text>
              <text style={s.hint}>
                Right-click anywhere in this card. Submenus nest two deep;
                Escape closes one level at a time.
              </text>
            </ContextMenu>
          </box>
        </scrollview>
      </SplitPane>

      {/* A popup is a real X window and needs its size before layout, so the
          dialog is sized explicitly rather than to its content. */}
      <Dialog
        open={dialog}
        title="A modal dialog"
        width={380}
        height={190}
        onClose={() => setDialog(false)}
        actions={
          <>
            <Button label="Cancel" onPress={() => setDialog(false)} />
            <Button
              primary
              autoFocus
              label="OK"
              onPress={() => setDialog(false)}
            />
          </>
        }
      >
        Dialogs live in their own window with focus trapped inside, so Tab
        should stay in here and Escape should close it — and focus should land
        back on the button that opened it.
      </Dialog>
    </box>
  );
}

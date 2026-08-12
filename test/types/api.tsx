/**
 * Type tests. Not run — compiled. `npm run typecheck` fails if the public
 * API stops matching src/index.d.ts, and the `@ts-expect-error` lines fail
 * if something that should be rejected starts being accepted.
 *
 * Keep this exercising the API the way the examples do; it is the only
 * thing that keeps hand-written declarations honest.
 */
import React, { useRef, useState } from 'react';
import { startTrace } from 'react-x11/debug';
import { XK_MULTI_KEY, isDeadKeysym } from 'react-x11/keysyms';
import type {
  BusHandle,
  CalendarHandle,
  BusKind,
  BusRef,
  BusStatus,
  FileDialogBackend,
  MessageBus,
} from 'react-x11';
import {
  Button,
  BusUnavailableError,
  Calendar,
  Canvas3D,
  activateWindow,
  Checkbox,
  closeBus,
  Icon,
  icons,
  iconNames,
  iconSize,
  fileDialogBackend,
  onAppOpen,
  registerApplication,
  useAppActivate,
  useAppOpen,
  NoFileDialogError,
  openFile,
  saveFile,
  serverTime,
  sessionBus,
  systemBus,
  useApp,
  useClipboard,
  useFileDialog,
  useGlobalMenu,
  useSessionBus,
  useSystemBus,
  ContextMenu,
  createRoot,
  DatePicker,
  PasswordInput,
  createStyles,
  Dialog,
  flattenStyle,
  lastInputTime,
  launchTimestamp,
  MenuBar,
  notifyStartupComplete,
  ProgressBar,
  Radio,
  RadioGroup,
  Select,
  Slider,
  SplitPane,
  Switch,
  Table,
  Tabs,
  ThemeProvider,
  Tooltip,
  Tree,
  useAnchor,
  useDirection,
  useTheme,
  useTopLevelWindow,
  useWindowId,
  windowIdOf,
} from '../../src/index.js';
import type {
  ChangeEvent,
  DrawnNode,
  CompositionEvent,
  KeyboardEvent,
  MouseEvent,
  NtkWindow,
  ScrollEvent,
  ScrollableNode,
  Style,
  StyleProp,
  TextInputNode,
  WheelEvent,
  WidgetChangeEvent,
} from '../../src/index.js';

// --- styles ----------------------------------------------------------------

const s = createStyles({
  root: { flexGrow: 1, padding: 16, gap: 12, backgroundColor: '#f5f6fa' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  half: { width: '50%', marginLeft: 'auto' },
  title: { fontSize: 20, color: '$text', fontWeight: 'bold' },
  // the box is the capitals down to the baseline, so this padding is even
  trimmed: { fontSize: 20, textBoxTrim: 'cap-alphabetic', padding: 8 },
  card: {
    borderRadius: 8,
    borderWidth: 1,
    borderStyle: 'dashed',
    cursor: 'pointer',
    transition: 120,
    ':hover': { backgroundColor: '#eee' },
    ':disabled': { color: '#999' },
  },
  responsive: {
    flexDirection: 'column',
    '@width >= 600': { flexDirection: 'row', gap: 24 },
  },
  perProperty: { transition: { backgroundColor: 200, left: 120 } },
  // issue #117: the focus ring is paint, so it is legal in a state block and
  // animatable; hit slop is neither paint nor layout
  ring: {
    outlineOffset: 2,
    transition: { outlineWidth: 80 },
    ':focus-visible': { outlineWidth: 3, outlineColor: '$accent' },
  },
  target: { hitSlop: 4 },
  perSide: { hitSlop: { top: 4, bottom: 4 } },
  // issue #262: per-side borders — a side width overrides the shorthand the
  // way paddingLeft overrides padding; a side colour is paint, so it may
  // change in a state block
  quote: {
    borderLeftWidth: 3,
    borderLeftColor: '$border',
    ':hover': { borderLeftColor: '$accent' },
  },
  rule: { borderWidth: 1, borderBottomWidth: 0, borderTopColor: '#ddd' },
  // issue #271: the logical edges and the direction that decides what they
  // mean. `direction` is layout, so it is not legal in a state block; the
  // logical border *colours* are paint, like the physical ones.
  mirrored: {
    direction: 'rtl',
    paddingStart: 12,
    paddingEnd: 4,
    marginStart: 8,
    marginEnd: 0,
    start: 0,
    borderStartWidth: 3,
    borderStartColor: '$accent',
    ':hover': { borderEndColor: '$border' },
  },
  // the text cascade: `color` on a container is how the labels inside it are
  // dimmed, and `:focus-within` is how the row follows the field in it
  field: {
    color: '$text',
    fontSize: 13,
    ':focus-within': { borderColor: '$borderFocus' },
    ':hover': { color: '$accent' },
  },
});

// @ts-expect-error — the size a container sets is layout, state blocks are not
createStyles({ bad: { ':focus-within': { fontSize: 12 } } });

// arrays, falsy entries, nesting
const composed: StyleProp = [s.root, false, null, [s.row, { padding: 4 }]];
const flat: Style = flattenStyle(composed);
const grow: number | undefined = flat.flexGrow;

// the `flex` shorthand: a share of what is left, or one of CSS's two keywords
createStyles({
  fill: { flex: 1 },
  sized: { flex: 'auto' },
  rigid: { flex: 'none', flexShrink: 0 },
});

// @ts-expect-error — 'fill' is not one of them
createStyles({ bad: { flex: 'fill' } });

// @ts-expect-error — 'sideways' is not a flexDirection
createStyles({ bad: { flexDirection: 'sideways' } });

// @ts-expect-error — layout properties may not go in a state block
createStyles({ bad: { ':hover': { padding: 4 } } });

// @ts-expect-error — unknown style property
createStyles({ bad: { colour: 'red' } });

// @ts-expect-error — hit slop is not paint, so it cannot go in a state block
createStyles({ bad: { ':focus-visible': { hitSlop: 4 } } });

// @ts-expect-error — a side width is layout, so it may not go in a state block
createStyles({ bad: { ':hover': { borderLeftWidth: 3 } } });

// @ts-expect-error — 'rtol' is not a direction
createStyles({ bad: { direction: 'rtol' } });

// @ts-expect-error — direction is layout, so it may not go in a state block
createStyles({ bad: { ':hover': { direction: 'rtl' } } });

// --- elements --------------------------------------------------------------

function Elements() {
  const boxRef = useRef<DrawnNode>(null);
  const scrollRef = useRef<ScrollableNode>(null);
  const winRef = useRef<NtkWindow>(null);
  const inputRef = useRef<TextInputNode>(null);
  const [text, setText] = useState('');

  // issue #252: what a ref hands back, without a cast. The element name is
  // `kind` — the name the element was registered under, which is what paint
  // order and the harness queries match on.
  const _kind: string | undefined = boxRef.current?.kind;
  const _focused: boolean | undefined = boxRef.current?.focused;
  const _within: boolean | undefined = boxRef.current?.focusWithin;
  // issue #271: the resolved direction, which is what a widget measuring a
  // pointer against this box has to read
  const _dir: 'ltr' | 'rtl' | undefined = boxRef.current?.direction;
  const _holds = () => boxRef.current?.contains(inputRef.current);
  // issue #253: the question the wheel asks a scroller on its way out
  const _room: boolean | undefined = scrollRef.current?.canScroll(0, 48);
  // focus() hands the node back, so an imperative handle can forward it
  const _refocus = () => inputRef.current?.blur().focus();
  // @ts-expect-error — the element name is `kind`; no node has a `type`
  const _noType = () => boxRef.current?.type;

  return (
    <window
      ref={winRef}
      title="types"
      width={480}
      height={320}
      minWidth={320}
      resizable={false}
      windowType="dialog"
      wmClass={['app', 'App']}
      states={['skip_taskbar', 'maximized']}
      fullscreen={false}
      decorations={false}
      onStatesChange={(states) => void states.includes('fullscreen')}
      style={s.root}
      onCloseRequest={() => {}}
      onResize={(ev) => void (ev.resized && ev.width + ev.height)}
      onClientMessage={(ev) => {
        // the name is what a handler branches on; null only for an atom the
        // server itself does not know
        if (ev.messageType === '_NET_SYSTEM_TRAY_OPCODE') {
          void (ev.data[1] + ev.data[2]);
          ev.preventDefault();
        }
        void (ev.atom + ev.format + Number(ev.defaultPrevented));
      }}
    >
      <box
        ref={boxRef}
        style={[s.row, s.card]}
        onClick={(ev) => void ev.detail}
      >
        <text style={s.title}>hello</text>
        <text>{text}</text>
        <text>{42}</text>
      </box>

      <box
        ref={scrollRef}
        scrollbar
        scrollbarColor="#ccc"
        style={[s.responsive, { overflow: 'scroll' }]}
        onScroll={(ev: ScrollEvent) => void ev.scrollY}
        onViewport={(ev) => void ev.contentHeight}
      >
        <box style={{ height: 800 }} />
      </box>

      <textinput
        ref={inputRef}
        value={text}
        name="subject"
        // issue #115: both idioms have to type-check — `ev.target.value` is
        // what every DOM form library reads, `ev.value` is the short form
        onChange={(ev) => setText(ev.target.value || ev.value)}
        onSubmit={(ev) => void (ev.value.length + (ev.name?.length ?? 0))}
        placeholder="type"
        maxLength={40}
        focusable
        tabIndex={0}
      />
      <textarea
        name="body"
        onChange={(ev: ChangeEvent<TextInputNode>) => {
          ev.preventDefault();
          void (ev.type === 'change' && ev.target.value);
          // null for an edit with no single X event behind it
          void ev.nativeEvent?.keycode;
        }}
      />
      <Button
        label="Undo"
        disabled={!inputRef.current?.canUndo}
        onPress={() => void inputRef.current?.undo()}
      />
      <textinput
        contextMenu={false}
        onContextMenu={(ev: MouseEvent<TextInputNode>) => {
          if (ev.button === 3) ev.preventDefault();
        }}
      />
      <textarea rows={4} defaultValue="multi" />
      <image src="./logo.png" style={{ width: 32, height: 32 }} />
      <canvas
        style={{ flexGrow: 1 }}
        onDraw={(ctx, { width, height }) => {
          ctx.fillStyle = 'tomato';
          ctx.fillRect(0, 0, width / 2, height);
        }}
      />
      <markdown source="# hi" onLink={(href) => void href.length} />
      <html source="<p>hi</p>" stylesheet="p { margin: 0 }" />
      <svg source="<svg/>" />
      <tex source="e^{i\\pi}" size={18} style={{ color: '#222' }} />
    </window>
  );
}

// --- events ----------------------------------------------------------------

function Events() {
  return (
    <box
      onMouseDown={(ev: MouseEvent) => {
        ev.capturePointer();
        ev.stopPropagation();
        void ev.nativeEvent.rootx;
        void ev.button;
      }}
      onWheel={(ev: WheelEvent) => {
        ev.preventDefault();
        void (ev.deltaX + ev.deltaY);
      }}
      onKeyDown={(ev: KeyboardEvent) => {
        void ev.key;
        void ev.codepoint;
        void ev.shiftKey;
        // Mod1 and Mod4, under the names the DOM gives them
        const chord: boolean = ev.altKey || ev.metaKey;
        void chord;
        // the Latin keysym, and which layout typed the character
        const layout: number = ev.group;
        void layout;
        // a key an open composition took types nothing of its own
        if (ev.composing) return;
      }}
      onCompositionStart={(ev: CompositionEvent) => void ev.data}
      onCompositionUpdate={(ev: CompositionEvent) => void ev.data}
      onCompositionEnd={(ev: CompositionEvent) => {
        void ev.data;
        ev.preventDefault();
      }}
      onMouseEnter={() => {}}
      onFocus={() => {}}
    />
  );
}

// The DOM is not the host here, so its elements are not in scope at all.
// This is what owning the JSX namespace buys over augmenting React's, where
// `@types/react` would keep declaring every HTML and SVG tag.
// @ts-expect-error — 'div' is not a react-x11 element
const _div = <div />;
// @ts-expect-error — 'img' is not one either, despite <image> existing
const _img = <img />;
// @ts-expect-error — <box> has no 'className'
const _classy = <box className="nope" />;
// Size is style everywhere except <window>, so the elements that measure
// themselves do not get to take it flat either (issue #118).
// @ts-expect-error — <image> is sized by style, not by a width prop
const _sized = <image src="./logo.png" width={40} />;
// @ts-expect-error — nor is <svg>
const _svg = <svg source="<svg/>" height={40} />;
// @ts-expect-error — <tex> ink colour is style={{ color }}
const _inked = <tex source="x^2" color="#222" />;

// A <window> size is pixels or 'auto', and leaving it out is the same
// request as 'auto' — the two axes are independent.
const _natural = <window title="natural" />;
const _autoBoth = <window width="auto" height="auto" />;
const _heightForWidth = <window width={600} height="auto" maxHeight={800} />;
// @ts-expect-error — 'fit-content' is what 'auto' already means here
const _fitContent = <window width="fit-content" />;
// @ts-expect-error — there is no containing block to be a percentage of
const _percent = <window height="100%" />;

// --- popups ----------------------------------------------------------------

function Popup() {
  return (
    <popup x={40} y={40} width={120} height={80} grab onDismiss={() => {}}>
      <box />
    </popup>
  );
}

// issue #255: a popup that hangs off a node — or off a rect inside one —
// and sizes itself from its content, so it never states a position at all
function AnchoredPopup() {
  const editor = useRef<DrawnNode>(null);
  const [caret, setCaret] = useState({ x: 0, y: 0, width: 1, height: 16 });
  return (
    <window title="editor">
      <box
        ref={editor}
        onClick={() => setCaret({ ...caret, x: caret.x + 7 })}
      />
      <popup
        anchor={{ to: editor, at: caret, placement: 'bottom', align: 'start' }}
        maxHeight={220}
      >
        <box />
      </popup>
      {/* the node itself is a target too, and so is the alignment's */}
      <popup anchor={{ to: editor.current, alignTo: editor, offset: 6 }}>
        <box />
      </popup>
    </window>
  );
}

// @ts-expect-error — `at` is a rect, not a pair of screen coordinates
const _badAt = <popup anchor={{ to: null, at: { left: 1, top: 2 } }} />;

// @ts-expect-error — the anchor has to name what it hangs off
const _noTarget = <popup anchor={{ placement: 'bottom' }} />;

// issue #130: transientFor takes a ref to a window, a ref to a drawn node, a
// raw XID or 'root'; a <popup> can opt out of override-redirect to become a
// WM-managed dialog
function TransientWindows() {
  const owner = useRef<NtkWindow>(null);
  const anchor = useRef<DrawnNode>(null);
  const windowId = useWindowId(anchor);
  const parentWindow = () => `x11:${(windowId() ?? 0).toString(16)}`;
  return (
    <>
      <window ref={owner} title="editor">
        <box ref={anchor} />
      </window>
      <window transientFor={owner} windowType="dialog" title="Preferences" />
      <window transientFor={anchor} />
      <window transientFor={windowIdOf(owner) ?? 0} />
      <window transientFor="root" />
      <window transientFor={null} onExpose={() => void parentWindow()} />
      <popup
        x={0}
        y={0}
        width={200}
        height={120}
        overrideRedirect={false}
        transientFor={anchor}
        windowType="dialog"
      >
        <box />
      </popup>
    </>
  );
}

// @ts-expect-error — a string is not a window, a node, an XID or 'root'
const _badTransient = <window transientFor="mainWindow" />;

// --- 3D --------------------------------------------------------------------

function Scene() {
  return (
    <Canvas3D
      style={{ flexGrow: 1 }}
      camera={{ position: [0, 2, 6], fov: 45 }}
      onPointerMissed={() => {}}
    >
      <ambientLight intensity={0.35} />
      <pointLight position={[5, 6, 6]} distance={20} />
      <group rotation={[0, 0.5, 0]}>
        <mesh
          position={[-1.6, 0, 0]}
          scale={1.2}
          onClick={(ev) => void ev.distance}
        >
          <boxGeometry args={[1.4, 1.4, 1.4]} />
          <meshPhongMaterial color="#2980b9" shininess={60} side="double" />
        </mesh>
        <mesh>
          <bufferGeometry position={[0, 0, 0, 1, 0, 0, 0, 1, 0]} />
          <meshBasicMaterial wireframe opacity={0.5} transparent />
        </mesh>
      </group>
    </Canvas3D>
  );
}

function RawGl() {
  return (
    <glarea
      style={{ flexGrow: 1 }}
      clearColor={[0, 0, 0, 1]}
      frameLoop="always"
      glx={{ DEPTH_SIZE: 24 }}
      onCreated={(gl) => gl.Enable(gl.DEPTH_TEST)}
      onDraw={(gl, { width }) => gl.Viewport(0, 0, width, width)}
      onError={(err) => void err.message}
    />
  );
}

function Embedded({ id }: { id: number }) {
  return (
    <foreign
      windowId={id}
      style={{ flexGrow: 1, backgroundColor: '#101014' }}
      focusable
      onEmbedded={({ id: wid, xembed, version }) => {
        const _id: number = wid;
        const _mode: boolean = xembed;
        const _v: number = version;
      }}
      onClientGone={() => {}}
      onRequestFocus={() => {}}
      onError={(err) => void err.message}
    />
  );
}

function Adopting() {
  // no windowId: the container's id is what a program is spawned into
  return (
    <foreign
      style={{ flexGrow: 1 }}
      onReady={({ windowId }) => {
        const _id: number = windowId;
      }}
    />
  );
}

// --- components ------------------------------------------------------------

function Themed() {
  // a complete palette, whatever the provider above set
  const theme = useTheme();
  const _radius: number = theme.radius;
  const _focus: string = theme.borderFocus;
  // the type the palette sets: what unstyled text takes, and the face code
  // surfaces ask for by name
  const _face: string = theme.fontFamily;
  const _mono: string = theme.monoFamily;
  const _size: number = theme.fontSize;
  // issue #271: the direction the palette carries, and the hook the widget
  // set reads it through
  const _themeDir: 'ltr' | 'rtl' = theme.direction;
  const _dir: 'ltr' | 'rtl' = useDirection();
  // issue #252: a component that reads a token by a name it was handed —
  // a code palette, a `$token` it is resolving itself — indexes the palette
  // instead of casting it. Unknown names are `unknown`, so they narrow.
  const pick = (token: string): string =>
    typeof theme[token] === 'string' ? (theme[token] as string) : theme.text;
  void pick('dim');
  return (
    <box
      style={{
        backgroundColor: theme.accent,
        fontFamily: theme.monoFamily,
        ':hover': { backgroundColor: theme.accentHover },
        // the pressed step: derived from the hover unless a palette names it
        ':active': { backgroundColor: theme.accentActive },
      }}
    />
  );
}

// @ts-expect-error — the palette is Partial<Theme>, not arbitrary keys
const _badTheme = <ThemeProvider value={{ accnet: '#fff' }} />;

// @ts-expect-error — `borderActive` was the focus border and is `borderFocus`
const _oldName = <ThemeProvider value={{ borderActive: '#fff' }} />;

const _pressedPalette = (
  <ThemeProvider value={{ surfaceActive: '#ddd', dimActive: '#556' }} />
);

function Widgets() {
  const anchorRef = useRef<DrawnNode>(null);
  const calendar = useRef<CalendarHandle>(null);
  const anchor = useAnchor(anchorRef);
  const [checked, setChecked] = useState(false);

  return (
    <ThemeProvider value={{ accent: '#2980b9', radius: 6 }} style={s.row}>
      <Themed />
      <box ref={anchorRef} style={s.row}>
        <Button
          primary
          onPress={() => {
            // the placement options, including a rect inside the node
            const rect = anchor({
              placement: 'start',
              align: 'center',
              offset: 4,
              at: { x: 12, y: 4, height: 16 },
              width: 180,
            });
            if (rect) void (rect.placement === 'left');
          }}
        >
          press
        </Button>
        <Button label="labelled" disabled />
        {/* the system icon set: a name from the union, and the drawings
            themselves for anything wanting the glyph without the component */}
        <Icon name="chevronDown" />
        <Icon name="check" size={iconSize(14)} color="$accent" />
        <Icon
          name="close"
          aria-hidden={false}
          aria-label="Close"
          onClick={() => {}}
          focusable
        />
        <canvas
          mono
          cacheKey={iconNames[0]}
          onDraw={icons.moreVertical}
          style={{ width: 12, height: 12, color: '$dim' }}
        />
        <Checkbox checked={checked} onChange={(ev) => setChecked(ev.value)}>
          check
        </Checkbox>
        {/* one signature across the library: the value widgets hand over a
            change event, exactly as <textinput> does, so a form library's
            handler can be passed straight in */}
        <Checkbox
          checked={checked}
          name="agree"
          onChange={(ev: WidgetChangeEvent<boolean>) => {
            void (ev.target.type === 'checkbox' && ev.target.checked);
            void ev.name;
            setChecked(ev.value);
          }}
        />
        <Switch
          checked={checked}
          name="notify"
          onChange={(ev) => setChecked(ev.value)}
        />
        <ProgressBar value={0.4} color="#2980b9" />
        <Slider
          value={20}
          min={0}
          max={100}
          step={5}
          name="volume"
          onChange={(ev) => void (ev.value.toFixed() + ev.target.type)}
        />
        <Tooltip label="hi" placement="bottom" delay={200}>
          <box />
        </Tooltip>

        <RadioGroup<string>
          value="a"
          name="flavour"
          onChange={(ev) => void (ev.value.toUpperCase() + ev.name)}
        >
          <Radio value="a">A</Radio>
          <Radio value="b" label="B" />
        </RadioGroup>

        <Select<number>
          value={1}
          name="qty"
          options={[{ value: 1, label: 'one' }]}
          onChange={(ev) => void ev.value.toFixed()}
        />
        <Select options={['plain', 'values']} />
      </box>

      <Calendar
        value="2026-08-07"
        min={new Date()}
        max="2026-12-31"
        isDateBlocked={(day, parts) =>
          day > '2026-09-01' && parts.weekday === 0
        }
        dayContent={(day, state) => (
          <text style={{ color: state.color }}>{day}</text>
        )}
        onChange={(ev) => void ev.value.slice(0, 4)}
      />
      <Calendar
        mode="range"
        defaultValue={{ start: '2026-08-01', end: null }}
        spanBlocked
        weekStartsOn={0}
        locale="en-GB"
        onMonthChange={(month) => void month.length}
        onChange={(ev) => void (ev.value.start ?? '').length}
      />
      <Calendar ref={calendar} focusable={false} focusVisible />
      <DatePicker
        name="when"
        value={null}
        placeholder="When?"
        onChange={(ev) => void ev.value}
      />
      <DatePicker
        mode="range"
        value={{ start: '2026-08-01', end: '2026-08-04' }}
        format={(value) => String(value)}
        disabled
        onChange={(ev) => void ev.value.end}
      />
      {/* @ts-expect-error a range value needs mode="range" */}
      <Calendar value={{ start: '2026-08-01', end: null }} />

      <PasswordInput
        name="password"
        value=""
        placeholder="Passphrase"
        maxLength={64}
        onChange={(ev) => void ev.value.length}
        onSubmit={(secret) => void secret.length}
        onRevealChange={(on) => void on}
        drawMask={(ctx, { width, height, color }) => {
          ctx.fillStyle = color;
          ctx.fillRect(0, height / 2, width, 2);
        }}
      />
      {/* @ts-expect-error the value is a string, not a number */}
      <PasswordInput value={42} />
      <textinput sensitive value="s3cret" onChange={() => {}} />

      <Tabs
        items={[{ id: 'a', label: 'A', content: <box /> }]}
        defaultValue="a"
        orientation="vertical"
        manual
        onChange={(id) => void id.length}
      />
      <Tree
        items={[
          { id: 'src', label: 'src', children: [{ id: 'a', label: 'a.js' }] },
        ]}
        defaultExpanded={['src']}
        onActivate={(id) => void id}
      />
      <Table<{ id: string; size: number }>
        columns={[
          { id: 'id', label: 'Name' },
          {
            id: 'size',
            label: 'Size',
            align: 'right',
            value: (row) => row.size,
            render: (row, { selected }) => (
              <text style={{ color: selected ? '$hoverText' : '$text' }}>
                {row.size}
              </text>
            ),
          },
        ]}
        rows={[{ id: 'a', size: 1 }]}
        defaultSort={{ column: 'size', direction: 'desc' }}
        onSelect={(id) => void id}
        onActivate={(id, row) => void `${id}${row.size}`}
      />
      <SplitPane direction="row" defaultSize={200} min={80}>
        <box />
        <box />
      </SplitPane>
      {/* The item vocabulary is dbusmenu's, so the same array both draws and
          exports to the desktop's panel. */}
      <MenuBar
        menus={[
          {
            label: 'File',
            items: [
              {
                label: 'Open',
                shortcut: [['Control', 'O']],
                iconName: 'document-open',
              },
              { type: 'separator' },
              { label: 'Save As…', enabled: false },
              { label: 'Hidden', visible: false },
              {
                label: 'Wrap lines',
                toggleType: 'checkmark',
                toggleState: 1,
              },
              { label: 'Discard', disposition: 'warning' },
              {
                label: 'Recent',
                items: [
                  { key: 'r1', label: 'notes.md', onSelect: (i) => void i },
                ],
              },
            ],
          },
        ]}
        onSelect={(item) => void item.label}
      />
      <MenuBar
        menus={[]}
        globalMenu={false}
        onGlobalMenuChange={(exported: boolean) => void exported}
      />
      <ContextMenu items={[{ label: 'Copy', shortcut: [['Control', 'C']] }]}>
        <box />
      </ContextMenu>
      <Dialog
        open
        title="Sure?"
        onClose={() => {}}
        actions={<Button label="OK" />}
      >
        <text>body</text>
      </Dialog>
      {/* the 1.x shape: override-redirect, dismissed by a press outside */}
      <Dialog open managed={false} onClose={() => {}}>
        <text>unmanaged</text>
      </Dialog>
    </ThemeProvider>
  );
}

// @ts-expect-error — Slider takes a number, not a string
const _badSlider = <Slider value="20" />;

// @ts-expect-error — Tabs items need an id
const _badTabs = <Tabs items={[{ label: 'A' }]} />;

// --- entry points ----------------------------------------------------------

async function main() {
  const root = await createRoot();
  root.render(<Elements />);
  root.render(<Widgets />, () => {});
  void root.app.X;
  await root.unmount();

  // the option bag, and a root that borrows a connection rather than owning
  const other = await createRoot({
    display: ':1',
    onXError: (err) => void err.message,
    onUncaughtError: (error, info) => void [error, info.componentStack],
    onDisconnect: (reason, err) => void [reason, err?.message],
  });
  await other.unmount();
  const borrowing = await createRoot({ app: root.app });
  await borrowing.unmount();

  // startup notification: on by default, three ways to say otherwise
  const off = await createRoot({ startupNotification: false });
  await off.unmount();
  const withId = await createRoot({ startupNotification: 'x_TIME1' });
  await withId.unmount();
  const manual = await createRoot({
    startupNotification: { id: 'x_TIME1', completeOn: 'manual' },
  });
  const when: number | null = launchTimestamp();
  void when;
  notifyStartupComplete();
  await manual.unmount();

  // @ts-expect-error — completeOn is a closed set
  await createRoot({ startupNotification: { completeOn: 'someday' } });

  // composition: the built-in table by default, and four ways to say
  // otherwise
  const composes: boolean = isDeadKeysym(0xfe51);
  void composes;
  const noCompose = await createRoot({ compose: false });
  await noCompose.unmount();
  const systemCompose = await createRoot({ compose: 'system' });
  await systemCompose.unmount();
  const ownCompose = await createRoot({
    compose: {
      file: '/usr/share/X11/locale/en_US.UTF-8/Compose',
      sequences: [[[XK_MULTI_KEY, 'l', 'd'], '\u{1F986}']],
    },
  });
  await ownCompose.unmount();

  // @ts-expect-error — compose takes a table, not a boolean either way
  await createRoot({ compose: true });

  // accelerators: the Latin keysym by default, and two ways to say otherwise
  const byLayout = await createRoot({ accelerators: 'layout' });
  await byLayout.unmount();
  const ownKeycodes = await createRoot({ accelerators: { 52: 'z', 54: 0x63 } });
  await ownKeycodes.unmount();
  // (a third name is caught at runtime rather than here: a string satisfies
  // `Record<number, string>`, since indexing one gives a string back)

  root.render(<Scene />);
  root.render(<RawGl />);
  root.render(<Popup />, () => {});
  root.render(<AnchoredPopup />);
  root.render(<Events />);
  await root.unmount();

  // react-x11/debug — the protocol tracer
  const trace = startTrace({ sink: 'chrome', path: '/tmp/t.json' });
  const everything = startTrace();
  const one = startTrace({ app: root.app, seq2stack: true });
  const stats = trace.stop();
  const n: number = stats.requests + stats.bytesOut + stats.replies;
  const perOpcode: Map<string, number> = everything.stop().byOpcode;
  // @ts-expect-error — not a sink
  startTrace({ sink: 'xml' });
  void [n, perOpcode, one.stats.errors, one.stop()];
}

// the clipboard facade: groups, options, and the two read contracts
function _Clip() {
  const app = useApp();
  const clipboard = useClipboard();
  async function go() {
    await clipboard.writeText('hi');
    await clipboard.write({ 'text/html': '<b>hi</b>', 'text/plain': 'hi' });
    await clipboard.writeText('sel', { selection: 'PRIMARY', time: 12 });
    const text: string = await clipboard.readText();
    const rich: string | Uint8Array | null = await clipboard.read('text');
    const png = await clipboard.read('image/png', { timeout: 500 });
    const files = await clipboard.readFiles();
    const first: string | undefined = files[0]?.path;
    const offered: string[] = await clipboard.targets();
    const stop = await clipboard.watch((ev) => {
      const empty: boolean = ev.owner === 0;
      void empty;
    });
    const stop2 = await clipboard.watch('PRIMARY', () => {});
    stop();
    stop2();
    await clipboard.clear('PRIMARY');
    void [app, text, rich, png, first, offered];
  }
  void go;
  return null;
}

// the two selection timestamps, straight off what useApp() hands back
function _SelectionTime() {
  const app = useApp();
  async function own(wid: number, selection: number) {
    // there was a user action, so ICCCM wants that event's own time
    const when: number | undefined = lastInputTime(app);
    app.X.SetSelectionOwner(wid, selection, when);
    // and there was not, so ask the server rather than writing CurrentTime
    const now: number = await serverTime(app);
    app.X.SetSelectionOwner(wid, selection, now);
  }
  void own;
  return null;
}

// the global menu: a component drawing its own bar, delegating like MenuBar
function _GlobalMenu() {
  const menus = [{ label: 'File', items: [{ label: 'Quit' }] }];
  const exported: boolean = useGlobalMenu(menus, {
    onSelect: (item) => void item.label,
    onAboutToShow: (item) => void item.items,
  });
  if (exported) return null; // the panel has it
  return <MenuBar menus={menus} globalMenu={false} />;
}

// custom URI schemes: registration, the two inbound events, and the raise
function _DeepLinks() {
  const win = useRef<NtkWindow | null>(null);

  useAppOpen((uris, ctx) => {
    const first: string = uris[0];
    // `null` is a real answer, and it is what activateWindow takes
    const when: number | null = ctx.timestamp;
    const raw: unknown = ctx.platformData['desktop-startup-id'];
    activateWindow(win, { timestamp: when });
    void [first, raw, ctx.startupId, ctx.activationToken];
  });
  useAppActivate(
    (ctx) => void activateWindow(win, { timestamp: ctx.timestamp }),
  );

  async function go() {
    const app = await registerApplication({
      appId: 'com.example.myapp',
      schemes: ['com.example.myapp'],
      onOpen: (uris) => void uris,
      onAction: (name, params) => void [name, params],
    });
    // null until it is checked — there may be no session bus
    if (app?.role === 'secondary') return;
    const path: string | undefined = app?.objectPath;
    await app?.release();

    // @ts-expect-error — role is a closed set
    void (app?.role === 'tertiary');
    // @ts-expect-error — appId is required
    await registerApplication({ schemes: ['com.example.myapp'] });

    const stop = onAppOpen(() => {});
    stop();

    const issued: boolean = activateWindow();
    activateWindow(0x1a00007, { timestamp: null, source: 2 });
    // @ts-expect-error — EWMH names two source indications
    activateWindow(win, { source: 3 });
    void [path, issued];
  }
  void go;
  return null;
}

// the bus floor: the hooks, the imperative pair, and the `required` overload
function _Bus() {
  const session: BusHandle = useSessionBus();
  const system = useSystemBus();

  // The terse path has to type-check on its own — no `status` in sight.
  if (!session.bus) return null;

  const status: BusStatus = session.status;
  const name: string | null = session.uniqueName;
  const why: BusUnavailableError | undefined = system.cause;
  const kind: BusKind | undefined = why?.kind;
  session.retry();

  async function go() {
    // The default answers null, so the null check is not optional.
    const ref = await sessionBus();
    if (ref) {
      const bus: MessageBus = ref.bus;
      const unique: string = ref.uniqueName;
      const names: string[] = await bus.listNames();
      // Anything else on the dbus-native surface stays reachable.
      await bus.exportInterface({}, '/org/example', {});
      await ref.release();
      void [unique, names];
    }
    // @ts-expect-error — null until it is checked
    (await systemBus()).release();

    // `required` narrows away the null.
    const required: BusRef = await sessionBus({ required: true });
    await required[Symbol.asyncDispose]();

    await closeBus('session');
    // @ts-expect-error — not a bus
    await closeBus('accessibility');
  }
  void go;
  return null;
}

// the file dialog: the ladder, the options, and what cancel looks like
function _Files() {
  const win = useRef<NtkWindow | null>(null);
  const {
    openFile: open,
    saveFile: save,
    selectFolder,
  } = useFileDialog({
    parentWindow: win,
  });

  async function go() {
    const files: string[] | null = await open({
      multiple: true,
      filters: [
        { name: 'Text', extensions: ['txt', 'md'] },
        { name: 'Images', mimeTypes: ['image/png'] },
      ],
      defaultFolder: '/tmp',
      acceptLabel: 'Import',
    });
    // Cancelling is `null`, not a throw — the terse path has to type-check.
    if (!files) return;
    const target: string | null = await save({ defaultName: 'out.md' });
    const dirs: string[] | null = await selectFolder();

    // The bare functions, for host-side code with no component to hang off.
    const bare: string[] | null = await openFile({ backend: 'builtin' });
    const backend: FileDialogBackend = await fileDialogBackend();
    // @ts-expect-error — not a rung
    await openFile({ backend: 'zenity' });
    // @ts-expect-error — a filter needs a name
    await openFile({ filters: [{ extensions: ['txt'] }] });

    try {
      await saveFile();
    } catch (err) {
      if (err instanceof NoFileDialogError) {
        const why: unknown = err.cause;
        void why;
      }
    }
    void [target, dirs, bare, backend];
  }
  void go;
  return null;
}

void _Files;
void _Bus;
void _DeepLinks;
void _Clip;
void main;
void grow;
void _div;
void _img;
void _classy;
void _badSlider;
void _badTabs;

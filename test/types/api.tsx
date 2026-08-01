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
import {
  Button,
  Canvas3D,
  Checkbox,
  ContextMenu,
  createRoot,
  createStyles,
  Dialog,
  flattenStyle,
  MenuBar,
  ProgressBar,
  Radio,
  RadioGroup,
  render,
  Select,
  Slider,
  SplitPane,
  Switch,
  Table,
  Tabs,
  ThemeProvider,
  Tooltip,
  Tree,
  unmountComponentAtNode,
  useAnchor,
  useTheme,
  useWindowId,
  windowIdOf,
} from '../../src/index.js';
import type {
  ChangeEvent,
  DrawnNode,
  KeyboardEvent,
  MouseEvent,
  NtkWindow,
  ScrollEvent,
  ScrollViewNode,
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
});

// arrays, falsy entries, nesting
const composed: StyleProp = [s.root, false, null, [s.row, { padding: 4 }]];
const flat: Style = flattenStyle(composed);
const grow: number | undefined = flat.flexGrow;

// @ts-expect-error — 'sideways' is not a flexDirection
createStyles({ bad: { flexDirection: 'sideways' } });

// @ts-expect-error — layout properties may not go in a state block
createStyles({ bad: { ':hover': { padding: 4 } } });

// @ts-expect-error — unknown style property
createStyles({ bad: { colour: 'red' } });

// --- elements --------------------------------------------------------------

function Elements() {
  const boxRef = useRef<DrawnNode>(null);
  const scrollRef = useRef<ScrollViewNode>(null);
  const winRef = useRef<NtkWindow>(null);
  const inputRef = useRef<TextInputNode>(null);
  const [text, setText] = useState('');

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
      onResize={(ev) => void ev.nativeEvent.rootx}
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

      <scrollview
        ref={scrollRef}
        scrollbar
        scrollbarColor="#ccc"
        style={s.responsive}
        onScroll={(ev: ScrollEvent) => void ev.scrollY}
        onViewport={(ev) => void ev.contentHeight}
      >
        <box style={{ height: 800 }} />
      </scrollview>

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
      <tex source="e^{i\\pi}" size={18} color="#222" />
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

// --- popups ----------------------------------------------------------------

function Popup() {
  return (
    <popup x={40} y={40} width={120} height={80} grab onDismiss={() => {}}>
      <box />
    </popup>
  );
}

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

// --- components ------------------------------------------------------------

function Themed() {
  // a complete palette, whatever the provider above set
  const theme = useTheme();
  const _radius: number = theme.radius;
  return <box style={{ backgroundColor: theme.accent }} />;
}

// @ts-expect-error — the palette is Partial<Theme>, not arbitrary keys
const _badTheme = <ThemeProvider value={{ accnet: '#fff' }} />;

function Widgets() {
  const anchorRef = useRef<DrawnNode>(null);
  const anchor = useAnchor(anchorRef);
  const [checked, setChecked] = useState(false);

  return (
    <ThemeProvider value={{ accent: '#2980b9', radius: 6 }} style={s.row}>
      <Themed />
      <box ref={anchorRef} style={s.row}>
        <Button primary onPress={() => void anchor()}>
          press
        </Button>
        <Button label="labelled" disabled />
        <Checkbox checked={checked} onChange={setChecked}>
          check
        </Checkbox>
        {/* issue #115: the next value stays first, so `onChange={setChecked}`
            still checks; the form event is an optional second argument */}
        <Checkbox
          checked={checked}
          name="agree"
          onChange={(next, ev: WidgetChangeEvent<boolean>) => {
            void (ev.target.type === 'checkbox' && ev.target.checked);
            setChecked(next);
          }}
        />
        <Switch checked={checked} name="notify" onChange={setChecked} />
        <ProgressBar value={0.4} color="#2980b9" />
        <Slider
          value={20}
          min={0}
          max={100}
          step={5}
          name="volume"
          onChange={(v, ev) => void (v.toFixed() + ev.target.type)}
        />
        <Tooltip label="hi" placement="bottom" delay={200}>
          <box />
        </Tooltip>

        <RadioGroup<string>
          value="a"
          name="flavour"
          onChange={(v, ev) => void (v.toUpperCase() + ev.name)}
        >
          <Radio value="a">A</Radio>
          <Radio value="b" label="B" />
        </RadioGroup>

        <Select<number>
          value={1}
          name="qty"
          options={[{ value: 1, label: 'one' }]}
          onChange={(v) => void v.toFixed()}
        />
        <Select options={['plain', 'values']} />
      </box>

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
          },
        ]}
        rows={[{ id: 'a', size: 1 }]}
        defaultSort={{ id: 'size', direction: 'desc' }}
        onSelect={(id) => void id}
      />
      <SplitPane direction="row" defaultSize={200} min={80}>
        <box />
        <box />
      </SplitPane>
      <MenuBar
        menus={[
          { label: 'File', items: [{ label: 'Open' }, { separator: true }] },
        ]}
        onSelect={(item) => void item.label}
      />
      <ContextMenu items={[{ label: 'Copy', shortcut: 'Ctrl+C' }]}>
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

  await render(<Scene />);
  render(<RawGl />, undefined, root.app);
  render(<Popup />, () => {}, root.app);
  render(<Events />, () => {}, root.app);
  unmountComponentAtNode(root.app);

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

void main;
void grow;
void _div;
void _img;
void _classy;
void _badSlider;
void _badTabs;

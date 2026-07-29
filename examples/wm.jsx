// A reparenting window manager, written in React.
//
// Every frame you see is a react-x11 <window>: the titlebar, the buttons and
// the resize handles are ordinary components with ordinary event handlers,
// and the application being managed is a foreign X window reparented inside
// that frame. wm-core.js does the protocol half — claiming the root,
// answering map and configure requests, keeping the client list — and this
// file is the part you can restyle.
//
// Run it against a nested server so it does not fight the one managing your
// desktop:
//
//   Xephyr :10 -screen 1200x800 &
//   DISPLAY=unix/:10 npm run examples:wm
//   DISPLAY=:10 xterm &            # give it something to manage
//
// Run with: npm run examples:wm  (needs an X server / DISPLAY with no other WM)
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
import { Image } from 'ntk';
import { createRoot, createStyles } from '../src/index.js';

import {
  BORDER,
  ICON_SIZE,
  TASKBAR_H,
  TITLE_H,
  WindowManager,
  frameHeight,
  frameWidth,
  resizeRect,
} from './wm-core.js';

const theme = {
  frame: '#2f3542',
  frameActive: '#3742fa',
  title: '#f1f2f6',
  titleDim: '#a4b0be',
  taskbar: '#1e2029',
  taskbarItem: '#2f3542',
  button: '#57606f',
  close: '#ff4757',
};

const s = createStyles({
  frame: { backgroundColor: theme.frame },
  titlebar: {
    height: TITLE_H,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 8,
    gap: 6,
    cursor: 'move',
  },
  title: { flexGrow: 1, color: theme.titleDim, fontSize: 12 },
  titleActive: { color: theme.title },
  button: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: theme.button,
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    ':hover': { backgroundColor: '#7f8fa6' },
  },
  closeButton: { ':hover': { backgroundColor: theme.close } },
  buttonGlyph: { fontSize: 9, color: theme.title },

  taskbarWindow: { backgroundColor: theme.taskbar },
  taskbar: {
    flexGrow: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 8,
    paddingRight: 8,
    gap: 6,
  },
  taskbarItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingLeft: 8,
    paddingRight: 10,
    height: 22,
    borderRadius: 4,
    backgroundColor: theme.taskbarItem,
    cursor: 'pointer',
    ':hover': { backgroundColor: '#57606f' },
  },
  taskbarItemActive: { backgroundColor: theme.frameActive },
  taskbarLabel: { fontSize: 11, color: theme.title },
  hint: { fontSize: 11, color: theme.titleDim },
  spacer: { flexGrow: 1 },
});

// The eight resize handles, named by the edges each one drags. resizeRect
// turns that plus a pointer delta into a new rect; handleStyle turns it into
// a strip along the frame's border.
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

const CURSORS = {
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
};

/**
 * A handle hugs the edges it drags and spans the side along the other axis,
 * inset by BORDER so the corners keep their own square. Corners drag both
 * axes and so are pinned on both.
 */
function handleStyle(edges) {
  const vertical = edges.includes('n') || edges.includes('s');
  const horizontal = edges.includes('e') || edges.includes('w');
  const spanX = vertical && !horizontal ? BORDER : undefined;
  const spanY = horizontal && !vertical ? BORDER : undefined;
  return {
    position: 'absolute',
    cursor: CURSORS[edges],
    top: edges.includes('n') ? 0 : spanY,
    bottom: edges.includes('s') ? 0 : spanY,
    left: edges.includes('w') ? 0 : spanX,
    right: edges.includes('e') ? 0 : spanX,
    width: horizontal ? BORDER : undefined,
    height: vertical ? BORDER : undefined,
  };
}

/**
 * A pointer drag that keeps working outside the window. Pointer capture
 * routes the events to this node; the X pointer grab is what makes the
 * server keep sending them once the pointer leaves the frame — without it a
 * drag stops at the window edge.
 */
function useDrag(frameRef, onMove) {
  const start = useRef(null);

  const onMouseDown = useCallback(
    (ev) => {
      start.current = { x: ev.nativeEvent.rootx, y: ev.nativeEvent.rooty };
      ev.capturePointer();
      frameRef.current?.grabPointer({ ownerEvents: false });
      ev.stopPropagation();
    },
    [frameRef],
  );

  const onMouseMove = useCallback(
    (ev) => {
      if (!start.current) return;
      onMove(
        ev.nativeEvent.rootx - start.current.x,
        ev.nativeEvent.rooty - start.current.y,
      );
    },
    [onMove],
  );

  const onMouseUp = useCallback(() => {
    start.current = null;
    frameRef.current?.ungrabPointer();
  }, [frameRef]);

  return { onMouseDown, onMouseMove, onMouseUp };
}

/**
 * The application's icon, whatever size it gave us, scaled into `size` by
 * the server: ntk uploads the pixels once as a picture and XRender does the
 * rest, so a 48x48 icon in a 16px slot costs one composite per repaint.
 * Renders nothing when the window has no icon — plenty do not.
 */
function Icon({ icon, size = ICON_SIZE }) {
  // the same icon object rides along in every snapshot, so this uploads once
  const image = useMemo(() => (icon ? new Image(icon) : null), [icon]);
  useEffect(() => () => image?.destroy(), [image]);
  if (!image) return null;
  return (
    <canvas
      style={{ width: size, height: size }}
      onDraw={(ctx) => ctx.drawImage(image, 0, 0, size, size)}
    />
  );
}

function TitleButton({ glyph, onPress, close }) {
  return (
    <box
      style={[s.button, close && s.closeButton]}
      onMouseDown={(ev) => ev.stopPropagation()}
      onClick={onPress}
    >
      <text style={s.buttonGlyph}>{glyph}</text>
    </box>
  );
}

function Frame({ wm, client }) {
  const frameRef = useRef(null);
  // the rect the current drag started from, so every move is measured
  // against where the window was when the pointer went down
  const origin = useRef(null);
  const lastClick = useRef(0);

  // Hand the frame's X window to the core once React has created it: that
  // is when the client can be reparented inside and shown.
  useEffect(() => {
    if (frameRef.current) wm.attachFrame(client.id, frameRef.current);
  }, [wm, client.id]);

  const remember = () => {
    origin.current = {
      x: client.x,
      y: client.y,
      width: client.width,
      height: client.height,
    };
  };

  const move = useDrag(frameRef, (dx, dy) => {
    const from = origin.current;
    if (from) wm.setGeometry(client.id, { x: from.x + dx, y: from.y + dy });
  });

  const onTitleDown = (ev) => {
    wm.focus(client.id);
    const now = Date.now();
    if (now - lastClick.current < 400) {
      lastClick.current = 0;
      wm.toggleMaximize(client.id);
      return;
    }
    lastClick.current = now;
    if (client.maximized) return; // a maximized window does not drag
    remember();
    move.onMouseDown(ev);
  };

  return (
    <window
      ref={frameRef}
      x={client.x}
      y={client.y}
      width={frameWidth(client.width)}
      height={frameHeight(client.height)}
      overrideRedirect
      style={[
        s.frame,
        client.focused && { backgroundColor: theme.frameActive },
      ]}
    >
      <box
        style={s.titlebar}
        onMouseDown={onTitleDown}
        onMouseMove={move.onMouseMove}
        onMouseUp={move.onMouseUp}
      >
        <Icon icon={client.icon} />
        <text style={[s.title, client.focused && s.titleActive]}>
          {client.title}
        </text>
        <TitleButton glyph="—" onPress={() => wm.minimize(client.id)} />
        <TitleButton
          glyph={client.maximized ? '❐' : '□'}
          onPress={() => wm.toggleMaximize(client.id)}
        />
        <TitleButton glyph="✕" close onPress={() => wm.close(client.id)} />
      </box>

      {!client.maximized &&
        HANDLES.map((edges) => (
          <ResizeHandle
            key={edges}
            edges={edges}
            wm={wm}
            client={client}
            frameRef={frameRef}
            origin={origin}
            remember={remember}
          />
        ))}
    </window>
  );
}

function ResizeHandle({ edges, wm, client, frameRef, origin, remember }) {
  const drag = useDrag(frameRef, (dx, dy) => {
    const from = origin.current;
    if (!from) return;
    wm.setGeometry(client.id, resizeRect(from, edges, dx, dy, client));
  });

  return (
    <box
      style={handleStyle(edges)}
      onMouseDown={(ev) => {
        wm.focus(client.id);
        remember();
        drag.onMouseDown(ev);
      }}
      onMouseMove={drag.onMouseMove}
      onMouseUp={drag.onMouseUp}
    />
  );
}

function Taskbar({ wm, clients }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) wm.claim(ref.current);
  }, [wm]);

  const area = wm.workArea;
  // dialogs belong to the window they came from, not to the taskbar
  const taskbarClients = clients.filter((client) => !client.transientFor);

  return (
    <window
      ref={ref}
      x={0}
      y={area.height}
      width={area.width}
      height={TASKBAR_H}
      overrideRedirect
      style={s.taskbarWindow}
    >
      <box style={s.taskbar}>
        {/* dialogs belong to the window they came from, not to the taskbar */}
        {taskbarClients.map((client) => (
          <box
            key={client.id}
            style={[s.taskbarItem, client.focused && s.taskbarItemActive]}
            onClick={() =>
              client.minimized ? wm.restore(client.id) : wm.focus(client.id)
            }
          >
            <Icon icon={client.icon} />
            <text style={s.taskbarLabel}>
              {client.minimized ? `· ${client.title}` : client.title}
            </text>
          </box>
        ))}
        <box style={s.spacer} />
        <text style={s.hint}>
          {taskbarClients.length} window{taskbarClients.length === 1 ? '' : 's'}{' '}
          · alt+tab
        </text>
      </box>
    </window>
  );
}

function Desktop({ wm }) {
  const clients = useSyncExternalStore(wm.subscribe, wm.getSnapshot);

  return (
    <>
      <Taskbar wm={wm} clients={clients} />
      {/* minimized frames stay mounted — the client is a child of the frame
          now, and unmounting one would take the application with it. The
          core unmaps them instead. */}
      {clients.map((client) => (
        <Frame key={client.id} wm={wm} client={client} />
      ))}
    </>
  );
}

export default Desktop;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  const wm = new WindowManager(root.app);
  await wm.start();
  root.render(<Desktop wm={wm} />);
}

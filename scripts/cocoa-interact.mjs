// Interactive smoke-drive of examples/chat.jsx on the cocoa backend: every
// gesture goes through the REAL pump (postMouseEvent/postKeyEvent -> NSApp
// -> pump2 -> the router -> EventManager), so what this proves is the whole
// input path, not the tree.
import React from 'react';

process.env.REACT_X11_NO_AUTORUN = '1';

const { createRoot } = await import('../src/index.js');
const { loadNative } = await import('../src/cocoa/native.js');
const { default: App } = await import('../examples/chat.jsx');

const native = loadNative();
const root = await createRoot();
root.render(React.createElement(App));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function windowNodes() {
  return root.app._rootChildren ?? [];
}

function* walk(node) {
  yield node;
  for (const child of node.children ?? []) yield* walk(child);
}

function find(pred, from = null) {
  const roots = from ? [from] : windowNodes();
  for (const rootNode of roots) {
    for (const node of walk(rootNode)) if (pred(node)) return node;
  }
  return null;
}

const byLabel = (label) => (n) => n.props?.['aria-label'] === label;
const byText = (text) => (n) =>
  n.kind === 'text' && [...(n.children ?? [])].some((c) => c.text === text);

function pointFor(node) {
  const win = node.root ?? node;
  const wnd = win.window;
  const s = wnd.scale;
  const abs = node.abs;
  return {
    wnd,
    x: (abs.x + abs.width / 2) / s,
    y: (abs.y + abs.height / 2) / s,
  };
}

async function click(node, { hold = 0 } = {}) {
  const { wnd, x, y } = pointFor(node);
  native.postMouseEvent(wnd._h, 'move', x, y);
  await sleep(30);
  native.postMouseEvent(wnd._h, 'down', x, y);
  if (hold) await sleep(hold);
  native.postMouseEvent(wnd._h, 'up', x, y);
  await sleep(60);
}

async function typeText(wnd, text) {
  for (const ch of text) {
    const keyCode = ch === '\n' ? 36 : 0;
    const chars = ch === '\n' ? '\r' : ch;
    native.postKeyEvent(wnd._h, true, keyCode, chars);
    native.postKeyEvent(wnd._h, false, keyCode, chars);
    await sleep(12);
  }
  await sleep(40);
}

async function wheel(node, notches) {
  const { wnd, x, y } = pointFor(node);
  // no native wheel posting yet: emit at the window layer (device px), the
  // one stage this script skips
  wnd.emit('wheel', {
    name: 'wheel',
    x: x * wnd.scale,
    y: y * wnd.scale,
    rootx: 0,
    rooty: 0,
    buttons: 0,
    deltaX: 0,
    deltaY: notches,
    deltaMode: 'line',
    smooth: false,
    source: 'button',
  });
  await sleep(80);
}

const shot = (name) => {
  let i = 0;
  for (const win of root.app._windows.values()) {
    const file = `/tmp/chat-${name}${i ? `-${i}` : ''}.png`;
    win.present();
    console.log(name, i, win.snapshot(file) ? file : 'FAILED');
    i++;
  }
};

try {
  await sleep(1200); // history suspense resolves, bots may talk

  // 1. switch channels
  const x11row = find(byLabel('#x11'));
  console.log('channel row found:', Boolean(x11row));
  await click(x11row);
  await sleep(700); // its history loads
  shot('1-switched');

  // 2. type into the composer and submit
  const input = find(byLabel('message #x11'));
  console.log('composer found:', Boolean(input));
  await click(input);
  const mainWnd = pointFor(input).wnd;
  await typeText(mainWnd, 'hello from the cocoa backend');
  shot('2-typed');
  await typeText(mainWnd, '\n');
  await sleep(120); // optimistic row, still pending
  shot('3-optimistic');
  await sleep(700); // fixture latency passes, tick lands
  shot('4-delivered');

  // 3. scroll the log up and back
  const log = find((n) => n.props?.['data-testname'] === 'log-#x11');
  await wheel(log, -3);
  shot('5-scrolled');

  // 4. open the sidebar menu (a <popup>)
  const menuButton = find(byText('⋮'));
  console.log('menu button found:', Boolean(menuButton));
  await click(menuButton);
  await sleep(250);
  shot('6-menu');

  // 5. choose "Join a channel…" -> Dialog (managed popup window)
  const joinItem = find(byText('Join a channel…'));
  console.log('join item found:', Boolean(joinItem), joinItem?.root?.isPopup);
  if (joinItem) {
    await click(joinItem);
    await sleep(600);
    shot('7-dialog');
    // type a filter into the dialog's autofocused input
    const dialogWnd = [...root.app._windows.values()].at(-1);
    await typeText(dialogWnd, 'fonts');
    await sleep(400);
    shot('8-filtered');
  }
} finally {
  await root.unmount();
  process.exit(0);
}

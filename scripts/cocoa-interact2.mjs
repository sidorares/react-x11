// Round 2: grab dismissal, Switch toggle, Dialog join, resize.
import React from 'react';

process.env.REACT_X11_NO_AUTORUN = '1';

const { createRoot } = await import('../src/index.js');
const { loadNative } = await import('../src/cocoa/native.js');
const { default: App } = await import('../examples/chat.jsx');

const native = loadNative();
const root = await createRoot();
root.render(React.createElement(App));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function* walk(node) {
  yield node;
  for (const child of node.children ?? []) yield* walk(child);
}
function find(pred) {
  for (const rootNode of root.app._rootChildren ?? []) {
    for (const node of walk(rootNode)) if (pred(node)) return node;
  }
  return null;
}
const byLabel = (label) => (n) => n.props?.['aria-label'] === label;
const byText = (text) => (n) =>
  n.kind === 'text' && [...(n.children ?? [])].some((c) => c.text === text);

function pointFor(node) {
  const wnd = (node.root ?? node).window;
  const s = wnd.scale;
  return {
    wnd,
    x: (node.abs.x + node.abs.width / 2) / s,
    y: (node.abs.y + node.abs.height / 2) / s,
  };
}
async function click(node) {
  const { wnd, x, y } = pointFor(node);
  native.postMouseEvent(wnd._h, 'move', x, y);
  await sleep(25);
  native.postMouseEvent(wnd._h, 'down', x, y);
  native.postMouseEvent(wnd._h, 'up', x, y);
  await sleep(80);
}
const windows = () => [...root.app._windows.values()];
const shot = (name) => {
  windows().forEach((w, i) => {
    w.present();
    console.log(
      name,
      i,
      w.snapshot(`/tmp/chat2-${name}${i ? `-${i}` : ''}.png`),
    );
  });
};

try {
  await sleep(1000);
  const mainWnd = windows()[0];

  // 1. open the menu, then click elsewhere in the main window -> the grab
  // routes the press to the popup as an outside press -> onDismiss closes it
  await click(find(byText('⋮')));
  await sleep(200);
  console.log(
    'menu open, windows:',
    windows().length,
    'grab:',
    Boolean(root.app._grabWindow),
  );
  native.postMouseEvent(mainWnd._h, 'down', 400, 300);
  native.postMouseEvent(mainWnd._h, 'up', 400, 300);
  await sleep(250);
  console.log(
    'after outside press, windows:',
    windows().length,
    'grab:',
    Boolean(root.app._grabWindow),
  );
  shot('1-dismissed');

  // 2. toggle the Switch (transition-driven thumb slide)
  const flaky = find(byLabel('drop the next send'));
  console.log('switch found:', Boolean(flaky));
  await click(flaky);
  await sleep(80); // mid-transition
  shot('2-switch-mid');
  await sleep(300);
  shot('3-switch-on');

  // 3. join a channel end-to-end through the dialog
  await click(find(byText('⋮')));
  await sleep(150);
  await click(find(byText('Join a channel…')));
  await sleep(600);
  const dialogInput = find(byLabel('channel to join'));
  console.log(
    'dialog input focused:',
    dialogInput === dialogInput?.root?.events?.focusManager?.focused,
  );
  const wnd2 = windows().at(-1);
  for (const ch of 'lobsters') {
    native.postKeyEvent(wnd2._h, true, 0, ch);
    native.postKeyEvent(wnd2._h, false, 0, ch);
    await sleep(10);
  }
  await sleep(300);
  await click(find(byText('Join')));
  await sleep(400);
  const joined = find(byLabel('#lobsters'));
  console.log(
    'joined channel row:',
    Boolean(joined),
    'windows now:',
    windows().length,
  );
  shot('4-joined');

  // 4. resize the window (controlled path + delegate echo)
  native.setWindowFrame(mainWnd._h, null, null, 560, 420);
  await sleep(300);
  console.log('after resize wnd:', mainWnd.width, mainWnd.height);
  shot('5-resized');
} finally {
  await root.unmount();
  process.exit(0);
}

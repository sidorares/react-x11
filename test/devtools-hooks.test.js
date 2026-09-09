// Hook source locations, over the same real bridge devtools.test.js drives.
//
// React works out where each hook was called by capturing a stack at the
// hook dispatch (react-debug-tools' inspectHooksOfFiber) and reading the
// frames below it — that is also how it recovers the custom-hook nesting
// the frontend shows names for. V8 keeps ten frames by default, and a
// loader leaves frames of its own between the hook and its call site:
// `tsx`, which every `npm run examples:*` goes through, costs about ten. So
// the identifying frames fall off the end, `hookSource` comes back all
// nulls, the nesting collapses, and DevTools shows the element's hooks with
// no names and no source lines.
//
// The frame budget is squeezed here rather than a loader stacked up: it is
// the same thing from React's side — the identifying frames are not in the
// captured stack — and it does not depend on how many frames the test
// runner happens to add. Five is where this tree loses them; a real app
// under `tsx` loses them at the default ten.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { createMockApp } from './helpers/mock-app.js';
import { fakeDevTools, unrefFurtherTimers } from './helpers/fake-devtools.js';

/** Every hook in the tree the backend sent back, nested ones included. */
function flatten(hooks, out = []) {
  for (const hook of hooks ?? []) {
    out.push(hook);
    flatten(hook.subHooks, out);
  }
  return out;
}

test('hook sources survive a stack too short to reach the call site', async (t) => {
  const devtools = await fakeDevTools();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'react-x11-dth-'));
  process.env.REACT_X11_DEVTOOLS = '1';
  process.env.REACT_X11_DEVTOOLS_PORT = String(devtools.port);
  process.env.REACT_X11_DEVTOOLS_STATE = path.join(stateDir, 'devtools.json');
  const limitBefore = Error.stackTraceLimit;
  t.after(async () => {
    delete process.env.REACT_X11_DEVTOOLS;
    delete process.env.REACT_X11_DEVTOOLS_PORT;
    delete process.env.REACT_X11_DEVTOOLS_STATE;
    Error.stackTraceLimit = limitBefore;
    unrefFurtherTimers();
    await devtools.close();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  // what a loader costs, in the one number React's stack capture reads
  Error.stackTraceLimit = 5;
  // imported after the environment is set: the hook installs from here
  const { createRoot } = await import('../src/index.js');

  // two levels of custom hooks, which is ordinary for an app's own and is
  // where the frames run out first
  function useLabel() {
    return React.useState('idle')[0];
  }
  function useStatus() {
    const label = useLabel();
    return React.useMemo(() => label.toUpperCase(), [label]);
  }
  function Panel() {
    const status = useStatus();
    return React.createElement('box', {
      style: { width: 60, height: 20 },
      accessibleName: status,
    });
  }

  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    React.createElement(
      'window',
      { width: 200, height: 100 },
      React.createElement(Panel),
    ),
  );
  await devtools.connected;
  await devtools.waitFor('operations');

  const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  const [rendererID] = [...hook.rendererInterfaces.keys()];
  const renderer = hook.rendererInterfaces.get(rendererID);
  const box = app.windows[0]._reactX11Node.children[0];
  // Panel is what rendered the box, so it heads the box's owners list
  const hostID = renderer.getElementIDForHostInstance(box);
  const [owner] = renderer.getOwnersList(hostID);
  assert.strictEqual(owner.displayName, 'Panel');

  devtools.send('inspectElement', {
    id: owner.id,
    rendererID,
    path: null,
    requestID: 1,
    forceFullData: true,
  });
  const inspected = await devtools.waitFor('inspectedElement');
  assert.strictEqual(inspected.payload.type, 'full-data');
  // hooks come over the bridge dehydrated: the tree itself is under `data`
  const hooks = flatten(inspected.payload.value?.hooks?.data);

  assert.deepStrictEqual(
    hooks.map((h) => h.name).sort(),
    ['Label', 'Memo', 'State', 'Status'],
    'the custom hooks are named, not just the built-ins they wrap',
  );
  const incomplete = hooks.filter(
    (h) => h.hookSource?.fileName == null || h.hookSource?.lineNumber == null,
  );
  assert.deepStrictEqual(
    incomplete.map((h) => h.name),
    [],
    'and every one of them knows where it was called',
  );
  assert.ok(
    hooks.every((h) =>
      h.hookSource.fileName.endsWith('devtools-hooks.test.js'),
    ),
    'at the call site in the app, not at a frame inside React',
  );
  assert.ok(
    Error.stackTraceLimit >= 50,
    'which is what enabling the bridge raises the frame budget for',
  );

  await x11Root.unmount();
});

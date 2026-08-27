// What a misspelled `$token` costs (#420).
//
// It used to cost the whole GUI: `resolveTokens` threw, and the throw was
// raised from the attach walk inside `appendInitialChild` — React completing
// the nearest host *ancestor*, which for a tree rendered at once is the
// `<window>`. Attributed there, it sailed past every error boundary the app
// had written inside that window and came out as `onUncaughtError`: a blank
// screen from one wrong character in a style value.
//
// The default now reports and carries on. `REACT_X11_STRICT_TOKENS=1` puts
// the throw back, and these pin the part that makes it usable: it lands on
// the offending node's own fiber, so a boundary at any depth catches it.
import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import { createRoot } from '../src/index.js';
import { appearanceChanged } from '../src/nodes.js';
import { createMockApp } from './helpers/mock-app.js';
import { runScript } from './helpers/run-script.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const nodeOf = (app, index = 0) => app.windows[index]._reactX11Node;

/** Capture console.error and process.exitCode around a body — the report
 *  sets the exit code on purpose, and a test asserting on it must not leak
 *  it into the runner's own result. */
async function captured(body) {
  const errors = [];
  const origError = console.error;
  const origCode = process.exitCode;
  console.error = (...a) => errors.push(a.map(String).join(' '));
  try {
    await body(errors);
  } finally {
    console.error = origError;
    errors.exitCode = process.exitCode;
    process.exitCode = origCode;
  }
  return errors;
}

test('a misspelled token drops one property and leaves the app standing', async () => {
  const app = createMockApp();
  const uncaught = [];
  const x11Root = await createRoot({
    app,
    onUncaughtError: (err) => uncaught.push(String(err?.message ?? err)),
  });
  const errors = await captured(async () => {
    x11Root.render(
      h(
        'window',
        { width: 100, height: 100 },
        h('box', {
          style: {
            backgroundColor: '$textMuted1',
            color: '$text',
            flexGrow: 1,
          },
        }),
      ),
    );
    await tick();
  });

  assert.deepStrictEqual(uncaught, [], 'nothing reaches the root as a crash');
  assert.strictEqual(app.windows.length, 1, 'the window is still there');
  const box = nodeOf(app).children[0];
  assert.strictEqual(
    box.style.backgroundColor,
    undefined,
    'the property nobody could resolve is dropped, not painted as "$…"',
  );
  assert.ok(box.style.color, 'the tokens that did resolve are untouched');
  assert.match(errors.join('\n'), /unknown theme token "\$textMuted1"/);
  assert.match(
    errors.join('\n'),
    /theme has border, borderFocus, background/,
    'the message lists the palette in force, which is most of the fix',
  );
  assert.match(errors.join('\n'), /REACT_X11_STRICT_TOKENS=1/, 'and the seam');
  assert.strictEqual(
    errors.exitCode,
    1,
    'a run that painted something wrong must not exit 0 — CI still fails',
  );
  await x11Root.unmount();
});

test('the report names the component that wrote the style', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  function Sidebar() {
    return h('box', { style: { backgroundColor: '$panle', flexGrow: 1 } });
  }
  const errors = await captured(async () => {
    x11Root.render(h('window', { width: 100, height: 100 }, h(Sidebar)));
    await tick();
  });
  // `<box>` alone never tells anyone whose box it was
  assert.match(errors.join('\n'), /in Sidebar/);
  await x11Root.unmount();
});

test('two misspellings in one style are two reports', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const errors = await captured(async () => {
    x11Root.render(
      h(
        'window',
        { width: 100, height: 100 },
        h('box', {
          style: { flexGrow: 1, backgroundColor: '$surfce', color: '$texd' },
        }),
      ),
    );
    await tick();
  });
  // naming only the first would send someone back for a second run
  const joined = errors.join('\n');
  assert.match(joined, /"\$surfce"/);
  assert.match(joined, /"\$texd"/);
  await x11Root.unmount();
});

test('a bad token in a state block is reported once, not once per restyle', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const errors = await captured(async () => {
    x11Root.render(
      h(
        'window',
        { width: 100, height: 100, theme: { panel: '#123456' } },
        h('box', {
          style: {
            flexGrow: 1,
            backgroundColor: '$panel',
            ':hover': { backgroundColor: '$panell' },
          },
        }),
      ),
    );
    await tick();
    // a live theme swap re-resolves the whole subtree; the same misspelling
    // must not print again for every palette the app tries
    x11Root.render(
      h(
        'window',
        { width: 100, height: 100, theme: { panel: '#654321' } },
        h('box', {
          style: {
            flexGrow: 1,
            backgroundColor: '$panel',
            ':hover': { backgroundColor: '$panell' },
          },
        }),
      ),
    );
    await tick();
  });
  const hits = errors.filter((line) => /\$panell/.test(line));
  assert.strictEqual(hits.length, 1, `reported once, saw ${hits.length}`);
  assert.match(hits[0], /in <box style> :hover/, 'named down to the block');
  assert.strictEqual(
    nodeOf(app).children[0].style.backgroundColor,
    '#654321',
    'and the token that does resolve still follows the swap',
  );
  await x11Root.unmount();
});

test('a desktop appearance change with a bad token does not take the process', async () => {
  // `appearanceChanged` runs from an X event with no React on the stack, so
  // there is no boundary anywhere that could catch a throw — it would unwind
  // into the frame loop. This is the case the default exists for.
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const errors = await captured(async () => {
    x11Root.render(
      h(
        'window',
        { width: 100, height: 100 },
        h('box', { style: { backgroundColor: '$nope', flexGrow: 1 } }),
      ),
    );
    await tick();
    assert.doesNotThrow(() => appearanceChanged(app));
    await tick();
  });
  assert.match(errors.join('\n'), /unknown theme token "\$nope"/);
  assert.strictEqual(app.windows.length, 1, 'the window survived the switch');
  await x11Root.unmount();
});

// ---------------------------------------------------------------------------
// REACT_X11_STRICT_TOKENS=1 — run out of process, since the flag is read once
// at import and the reconciler's finalizeInitialChildren is gated on it.

const STRICT = { REACT_X11_STRICT_TOKENS: '1' };

const boundary = `
  class Boundary extends React.Component {
    constructor(p) { super(p); this.state = { err: null }; }
    static getDerivedStateFromError(err) { return { err }; }
    render() {
      return this.state.err
        ? React.createElement('box', { style: { backgroundColor: '#f00' } })
        : this.props.children;
    }
  }
`;

test('strict: a boundary inside the window catches a bad token on mount', async () => {
  // The whole point. Before the deferral to commitMount this was structurally
  // impossible: the throw was attributed to the <window> above the boundary.
  const { stdout } = await runScript(
    `
    import React from 'react';
    import { createRoot } from './src/index.js';
    import { createMockApp } from './test/helpers/mock-app.js';
    const h = React.createElement;
    ${boundary}
    const app = createMockApp();
    const uncaught = [];
    const root = await createRoot({
      app,
      onUncaughtError: (e) => uncaught.push(String(e?.message ?? e)),
      onCaughtError: () => {},
    });
    console.error = () => {};
    root.render(
      h('window', { width: 100, height: 100 },
        h('box', null,
          h(Boundary, null,
            h('box', { style: { backgroundColor: '$nope', flexGrow: 1 } })))));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const box = app.windows[0]._reactX11Node.children[0].children[0];
    process.stdout.write(JSON.stringify({
      uncaught: uncaught.length,
      windows: app.windows.length,
      fallback: box.style.backgroundColor,
    }));
    process.exitCode = 0;
    `,
    STRICT,
  );
  assert.deepStrictEqual(JSON.parse(stdout), {
    uncaught: 0,
    windows: 1,
    fallback: '#f00',
    // the boundary's fallback is on screen and the window is still up: the
    // blast radius is the subtree that named the token, not the app
  });
});

test('strict: with no boundary it is fatal, which is what strict means', async () => {
  const { stdout } = await runScript(
    `
    import React from 'react';
    import { createRoot } from './src/index.js';
    import { createMockApp } from './test/helpers/mock-app.js';
    const h = React.createElement;
    const app = createMockApp();
    const uncaught = [];
    const root = await createRoot({
      app,
      onUncaughtError: (e) => uncaught.push(String(e?.message ?? e)),
    });
    console.error = () => {};
    root.render(
      h('window', { width: 100, height: 100 },
        h('box', { style: { backgroundColor: '$nope', flexGrow: 1 } })));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    process.stdout.write(JSON.stringify({ uncaught }));
    process.exitCode = 0;
    `,
    STRICT,
  );
  const { uncaught } = JSON.parse(stdout);
  // React re-renders a root whose commit threw with nothing to catch it, so
  // the same error can arrive more than once — what matters is that it got
  // there at all, and said what it was
  assert.ok(uncaught.length >= 1, 'the root heard about it');
  for (const message of uncaught) {
    assert.match(message, /unknown theme token "\$nope"/);
  }
});

test('strict: a bad token arriving on an update reaches the boundary too', async () => {
  const { stdout } = await runScript(
    `
    import React from 'react';
    import { createRoot } from './src/index.js';
    import { createMockApp } from './test/helpers/mock-app.js';
    const h = React.createElement;
    ${boundary}
    const app = createMockApp();
    const uncaught = [];
    const root = await createRoot({
      app,
      onUncaughtError: (e) => uncaught.push(String(e?.message ?? e)),
      onCaughtError: () => {},
    });
    console.error = () => {};
    let go;
    function Inner() {
      const [bad, set] = React.useState(false);
      go = () => set(true);
      return h('box', {
        style: { flexGrow: 1, backgroundColor: bad ? '$nope' : '#fff' },
      });
    }
    root.render(
      h('window', { width: 100, height: 100 },
        h(Boundary, null, h(Inner))));
    await new Promise((r) => setImmediate(r));
    go();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const box = app.windows[0]._reactX11Node.children[0];
    process.stdout.write(JSON.stringify({
      uncaught: uncaught.length,
      fallback: box.style.backgroundColor,
    }));
    process.exitCode = 0;
    `,
    STRICT,
  );
  assert.deepStrictEqual(JSON.parse(stdout), {
    uncaught: 0,
    fallback: '#f00',
  });
});

test('strict: a good token still costs nothing but the commitMount', async () => {
  const { stdout } = await runScript(
    `
    import React from 'react';
    import { createRoot } from './src/index.js';
    import { createMockApp } from './test/helpers/mock-app.js';
    const h = React.createElement;
    const app = createMockApp();
    const root = await createRoot({ app });
    root.render(
      h('window', { width: 100, height: 100, theme: { panel: '#abcdef' } },
        h('box', { style: { backgroundColor: '$panel', flexGrow: 1 } })));
    await new Promise((r) => setImmediate(r));
    const box = app.windows[0]._reactX11Node.children[0];
    process.stdout.write(JSON.stringify({ bg: box.style.backgroundColor }));
    `,
    STRICT,
  );
  assert.deepStrictEqual(JSON.parse(stdout), { bg: '#abcdef' });
});

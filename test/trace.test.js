// The protocol tracer (react-x11/debug, issue #127): request framing and
// opcode naming against the in-process X server, sink behaviour, and the
// detach contract. The tracer attaches post-handshake by construction, so
// there is no auth-cookie case to test — the bytes are gone before it can
// look.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import React from 'react';
import ReactX11 from '../src/index.js';
import { startTrace, startEnvTrace } from '../src/debug.js';
import { createMockApp } from './helpers/mock-app.js';

import xserver from 'x11/lib/xserver/index.js';
import { createClient, StaticFontSource } from 'ntk';

const require = createRequire(import.meta.url);
const fontDir = join(
  dirname(require.resolve('katex/package.json')),
  'dist',
  'fonts',
);

async function createHeadlessApp() {
  const server = xserver.createServer({ width: 640, height: 480 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const fontSource = new StaticFontSource();
  fontSource.add(readFileSync(join(fontDir, 'KaTeX_Main-Regular.ttf')), {
    family: 'Test Main',
  });
  fontSource.alias('sans-serif', 'Test Main');
  const app = await createClient({ stream: clientEnd, fontSource });
  return app;
}

const settle = (app, roundTrips = 1) =>
  Array.from({ length: roundTrips }).reduce(
    (chain) =>
      chain.then(
        () =>
          new Promise((resolve, reject) =>
            app.X.GetInputFocus((err) => (err ? reject(err) : resolve())),
          ),
      ),
    Promise.resolve(),
  );

function render(element, app) {
  return new Promise((resolve) => {
    ReactX11.render(element, (instance) => resolve(instance), app);
  });
}

test('counts framed requests and decodes their names exactly', async () => {
  const app = await createHeadlessApp();
  try {
    await settle(app); // a quiet, aligned stream before attaching
    const trace = startTrace({ app });
    assert.strictEqual(trace.stats.requests, 0);
    assert.strictEqual(trace.stats.bytesOut, 0);

    // GetInputFocus is a 4-byte request with a reply: the counts it should
    // produce are exact, which pins both the framing and the naming.
    await settle(app, 2);
    assert.strictEqual(trace.stats.requests, 2);
    assert.strictEqual(trace.stats.bytesOut, 8);
    assert.strictEqual(trace.stats.replies, 2);
    assert.strictEqual(trace.stats.byOpcode.get('GetInputFocus'), 2);

    const stats = trace.stop();
    // stopping detaches: nothing after it is counted
    await settle(app, 2);
    assert.strictEqual(stats.requests, 2);
    assert.strictEqual(trace.stats.requests, 2);
  } finally {
    await app.close();
  }
});

test('a rendered tree shows up as named core and Render requests', async () => {
  const app = await createHeadlessApp();
  try {
    await settle(app);
    const trace = startTrace({ app });
    await render(
      React.createElement(
        'window',
        { width: 300, height: 200, style: { backgroundColor: '#204060' } },
        React.createElement('box', {
          style: { width: 80, height: 40, backgroundColor: '#e74c3c' },
        }),
      ),
      app,
    );
    await settle(app, 3);
    const stats = trace.stop();
    assert.ok(stats.byOpcode.get('CreateWindow') >= 1, 'window creation');
    const names = [...stats.byOpcode.keys()];
    assert.ok(
      names.some((n) => n.startsWith('Render.')),
      `paint should issue Render requests, saw: ${names.join(', ')}`,
    );
    // decoded, not numeric: nothing should have fallen back to extN.M
    assert.ok(
      names.every((n) => !/^core\d/.test(n)),
      `unnamed core opcode in ${names.join(', ')}`,
    );
    assert.ok(stats.bytesIn > 0);
  } finally {
    ReactX11.unmountComponentAtNode(app);
    await app.close();
  }
});

test('chrome sink writes a valid trace with commits, frames and requests', async () => {
  const app = await createHeadlessApp();
  const path = join(mkdtempSync(join(tmpdir(), 'rx11-trace-')), 'trace.json');
  try {
    await settle(app);
    const trace = startTrace({ app, sink: 'chrome', path });
    const instance = await render(
      React.createElement(
        'window',
        { width: 300, height: 200 },
        React.createElement('box', {
          style: { width: 80, height: 40, backgroundColor: '#27ae60' },
        }),
      ),
      app,
    );
    // run the scheduled frame deterministically (see AGENTS.md on the
    // stalled frame clock under synthetic input)
    const root = instance._reactX11Node;
    root._scheduled = false;
    root.flush();
    await settle(app, 2);
    trace.stop();

    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    assert.ok(Array.isArray(parsed.traceEvents));
    const phases = new Set(parsed.traceEvents.map((e) => e.ph));
    assert.ok(phases.has('i'), 'request instants');
    assert.ok(phases.has('X'), 'slices');
    const names = new Set(parsed.traceEvents.map((e) => e.name));
    assert.ok(names.has('commit'), 'a React commit slice');
    assert.ok(names.has('frame'), 'a painted frame slice');
    const frame = parsed.traceEvents.find((e) => e.name === 'frame');
    assert.ok(
      frame.args.reasons.includes('mount'),
      'the first frame is the mount',
    );
  } finally {
    ReactX11.unmountComponentAtNode(app);
    await app.close();
  }
});

test('seq2stack maps an X error back to the request that caused it', async () => {
  const app = await createHeadlessApp();
  const path = join(mkdtempSync(join(tmpdir(), 'rx11-trace-')), 'trace.json');
  try {
    await settle(app);
    const trace = startTrace({ app, sink: 'chrome', path, seq2stack: true });
    // a request against a drawable that does not exist errors asynchronously
    function offendingRequest() {
      app.X.GetGeometry(0x7fffffff, () => {});
    }
    offendingRequest();
    await settle(app, 2);
    trace.stop();
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const error = parsed.traceEvents.find((e) =>
      String(e.name).startsWith('Error'),
    );
    assert.ok(error, 'the error reached the trace');
    assert.match(error.name, /GetGeometry/);
    assert.match(String(error.args.stack), /offendingRequest/);
  } finally {
    await app.close();
  }
});

test('is inert on a mock app and rejects unknown sinks', async () => {
  const trace = startTrace({ app: createMockApp() }); // no pack_stream: no-op
  assert.strictEqual(trace.stats.requests, 0);
  trace.stop();
  assert.throws(() => startTrace({ sink: 'xml' }), /unknown trace sink/);
  assert.strictEqual(startEnvTrace('nonsense'), null);
  const env = startEnvTrace('summary');
  assert.ok(env);
  env.stop();
});

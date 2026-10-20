// What `react-x11 dev`'s error window says, read through `describeError`
// (src/cli/errorwindow.js) without rendering it: the sessions in
// test/cli-dev.test.js see the window open and close, and this is what is in
// it — the heading, where it points, the source around there, and which
// frames are shown.
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeError } from '../src/cli/errorwindow.js';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

const SOURCE = [
  "import React from 'react';",
  '',
  'function Broken() {',
  "  throw new Error('boom');",
  '}',
  '',
  'export default function App() {',
  '  return <Broken />;',
  '}',
].join('\n');

function withApp(run) {
  const dir = mkdtempSync(join(tmpdir(), 'react-x11-errwin-'));
  const file = join(dir, 'app.jsx');
  writeFileSync(file, SOURCE);
  try {
    run(dir, file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a render error: the app frame it was thrown in, the source around it, and what was hidden', () => {
  withApp((dir, file) => {
    const error = new Error('boom');
    error.stack = [
      'Error: boom',
      `    at Broken (${file}:4:9)`,
      `    at renderWithHooks (${dir}/node_modules/react-reconciler/cjs/react-reconciler.development.js:4206:24)`,
      `    at Chart (${dir}/node_modules/chart-lib/index.js:10:3)`,
      `    at Node.appendChild (${SRC}nodes/node.js:300:5)`,
      '    at process.processImmediate (node:internal/timers:483:21)',
      `    at App (${file}:8:10)`,
    ].join('\n');
    const info = describeError(
      {
        kind: 'render',
        error,
        componentStack:
          '\n    at Broken (<anonymous>)\n    at box\n    at App (<anonymous>)',
      },
      dir,
    );

    assert.strictEqual(info.heading, 'Error: boom');
    assert.strictEqual(info.detail, '');
    assert.deepStrictEqual(
      info.components,
      ['App', 'Broken'],
      'outermost first, components only',
    );
    assert.deepStrictEqual(
      {
        file: info.location.file,
        line: info.location.line,
        column: info.location.column,
      },
      { file, line: 4, column: 9 },
    );
    assert.strictEqual(
      info.location.where,
      'app.jsx:4:9',
      'relative to where dev runs',
    );

    assert.deepStrictEqual(
      info.excerpt.map(({ number, at }) => [number, at]),
      [
        [1, false],
        [2, false],
        [3, false],
        [4, true],
        [5, false],
        [6, false],
      ],
    );
    assert.strictEqual(info.excerpt[3].text, "  throw new Error('boom');");

    // React's, Node's and react-x11's own frames are counted, not shown; an
    // installed package's frame is shown, as not the app's own
    assert.deepStrictEqual(
      info.frames.map(({ label, own }) => [label, own]),
      [
        ['Broken', true],
        ['Chart', false],
        ['App', true],
      ],
    );
    assert.strictEqual(info.hidden, 3);
  });
});

test('the heading names a TypeError, and a message of several lines keeps the rest as detail', () => {
  const error = new TypeError(
    'cannot read x\nof undefined, at the second line',
  );
  error.stack = 'TypeError: cannot read x';
  const info = describeError({ kind: 'render', error });
  assert.strictEqual(info.heading, 'TypeError: cannot read x');
  assert.strictEqual(info.detail, 'of undefined, at the second line');
  assert.strictEqual(info.location, null, 'no frame of anyone’s');
  assert.strictEqual(info.excerpt, null);
});

test('a compile error points at the line babel names, without babel’s path and position in the heading', () => {
  withApp((dir, file) => {
    const error = new SyntaxError(
      `${file}: Unexpected token (8:10)\n\n  6 |\n  7 | export default function App() {\n> 8 |   return <Broken />;`,
    );
    error.loc = { line: 8, column: 9 };
    error.stack = `SyntaxError: x\n    at JSXParserMixin.raise (${dir}/node_modules/@babel/parser/lib/index.js:6397:19)`;
    const info = describeError({ kind: 'compile', error, filename: file }, dir);
    assert.strictEqual(info.heading, 'SyntaxError: Unexpected token');
    assert.strictEqual(info.detail, '', 'the window draws its own excerpt');
    assert.strictEqual(
      info.location.where,
      'app.jsx:8:10',
      'babel counts columns from 0',
    );
    assert.ok(info.excerpt.find((line) => line.at).text.includes('<Broken />'));
    assert.deepStrictEqual(
      info.frames,
      [],
      'the stack is the parser’s, not the app’s',
    );
    assert.strictEqual(info.hidden, 0);
  });
});

test('a compile error with no position keeps the frame it carries as detail', () => {
  withApp((dir, file) => {
    const error = new SyntaxError(
      `${file}: react-x11/refresh: \`createRoot\` is a named import called at module top level.\n  1 | import { createRoot } from 'react-x11';\n> 2 | await createRoot();`,
    );
    error.stack = `SyntaxError: ${error.message}`;
    const info = describeError({ kind: 'compile', error, filename: file }, dir);
    assert.strictEqual(
      info.heading,
      'SyntaxError: react-x11/refresh: `createRoot` is a named import called at module top level.',
    );
    assert.match(info.detail, /^ {2}1 \| import \{ createRoot \}/);
    assert.strictEqual(info.location, null);
  });
});

// The loader half of react-x11/refresh: the transform and its enforced
// constraints. These used to be folklore in the example's comments; now
// they are errors, and this file pins the error and the seam both.
import { test, describe } from 'node:test';
import assert from 'node:assert';
import * as nodeModule from 'node:module';
import { createTransformer, registerRefresh } from '../src/refresh/loader.js';

// The Node floor check sits in front of option validation, so these
// registerRefresh assertions only hold where the floor is met.
const hooksSupported = typeof nodeModule.registerHooks === 'function';

const COMPONENT = `
import React from 'react';
export default function App() {
  const [n, setN] = React.useState(0);
  return <box style={{ width: n }} />;
}
`;

describe('the transform', () => {
  test('instruments components and injects the refresh prelude + footer', async () => {
    const t = await createTransformer();
    const { code } = t.transform(COMPONENT, '/tmp/app.jsx');
    assert.match(
      code,
      /import __ReactX11Refresh from "file:.*refresh.index\.js"/,
    );
    assert.match(code, /\$RefreshReg\$/, 'components should be registered');
    assert.match(code, /React\.createElement/, 'classic JSX runtime');
    assert.match(
      code,
      /moduleReady\(import\.meta\.hot, import\.meta\.url, \{ "App": App \}\)/,
      'the footer hands the exports to the runtime',
    );
  });

  test('matches only the configured extensions', async () => {
    const t = await createTransformer();
    assert.ok(t.matches('/a/app.jsx'));
    assert.ok(!t.matches('/a/store.js'));
    const custom = await createTransformer({ extensions: ['.jsx', '.hot.js'] });
    assert.ok(custom.matches('/a/store.hot.js'));
  });

  test('a user prelude is injected, one statement per line', async () => {
    const t = await createTransformer({
      prelude: [`globalThis.__WORKBENCH__ = true`],
    });
    const { code } = t.transform(COMPONENT, '/tmp/app.jsx');
    const preludeEnd = code.indexOf('import React');
    assert.ok(
      code.slice(0, preludeEnd).includes('globalThis.__WORKBENCH__ = true;'),
      'user prelude should sit above the module body',
    );
  });
});

describe('the boundary decision (footer exports)', () => {
  const footerArg = (code) =>
    code.match(/moduleReady\(import\.meta\.hot, import\.meta\.url, (.*)\);/)[1];

  test('no exports (an entry) is never a boundary', async () => {
    const t = await createTransformer();
    const { code } = t.transform(`const x = 1;`, '/tmp/entry.jsx');
    assert.strictEqual(footerArg(code), 'null');
  });

  test('named and default exports are handed over by name', async () => {
    const t = await createTransformer();
    const { code } = t.transform(
      `export const A = () => <box />;\nfunction B() { return null; }\nexport default B;`,
      '/tmp/two.jsx',
    );
    assert.strictEqual(footerArg(code), '{ "A": A, "B": B }');
  });

  test('re-exports, export * and an anonymous default are opaque', async () => {
    const t = await createTransformer();
    for (const source of [
      `export * from './other.jsx';`,
      `export { A } from './other.jsx';`,
      `export default () => <box />;`,
    ]) {
      const { code } = t.transform(source, '/tmp/opaque.jsx');
      assert.strictEqual(footerArg(code), 'null', source);
    }
  });
});

describe('enforced constraint: no named-import calls at module top level', () => {
  test('a top-level named-import call is a transform error naming the fix', async () => {
    const t = await createTransformer();
    assert.throws(
      () =>
        t.transform(
          `import { createContext } from 'react';\nexport const Ctx = createContext(null);`,
          '/tmp/ctx.jsx',
        ),
      (err) => {
        assert.match(
          err.message,
          /`createContext` is a named import called at module top level/,
        );
        assert.match(
          err.message,
          /React\.createContext/,
          'the fix is in the message',
        );
        assert.match(err.message, /ctx\.jsx/, 'the module is named');
        return true;
      },
    );
  });

  test('the same call inside a component, or via the default import, is fine', async () => {
    const t = await createTransformer();
    t.transform(
      `import React from 'react';\nexport const Ctx = React.createContext(null);`,
      '/tmp/ok1.jsx',
    );
    t.transform(
      `import { useState } from 'react';\nexport function App() { const [n] = useState(0); return null; }`,
      '/tmp/ok2.jsx',
    );
  });
});

describe('enforced constraint: classic JSX runtime', () => {
  test("jsxRuntime: 'automatic' is rejected with the reason", async () => {
    await assert.rejects(
      createTransformer({ jsxRuntime: 'automatic' }),
      /jsxRuntime must be 'classic'.*react\/jsx-runtime/s,
    );
  });
});

describe('enforced constraint: one statement per prelude line', () => {
  test('two statements in one entry are rejected', async () => {
    await assert.rejects(
      createTransformer({ prelude: ['const a = 1; const b = 2'] }),
      /prelude\[0\] holds 2 statements/,
    );
  });

  test('a newline inside an entry is rejected', async () => {
    await assert.rejects(
      createTransformer({ prelude: ['const a = 1\nconst b = 2'] }),
      /prelude\[0\] contains a newline/,
    );
  });

  test('an unparsable entry is rejected', async () => {
    await assert.rejects(
      createTransformer({ prelude: ['const ='] }),
      /prelude\[0\] does not parse/,
    );
  });
});

describe('registerRefresh guards', () => {
  test('refuses to run under NODE_ENV=production', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await assert.rejects(registerRefresh(), /no production hot path/);
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });

  test('rejects a non-function ignore before touching the hooks', async () => {
    await assert.rejects(
      registerRefresh({ ignore: '/stores/' }),
      hooksSupported
        ? /ignore must be a function/
        : /needs module\.registerHooks/,
    );
  });
});

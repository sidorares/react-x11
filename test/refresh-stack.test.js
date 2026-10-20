// A stack through hot modules points at the source's own lines. Two layers
// each put lines above a module — react-x11's loader its refresh prelude,
// hot-module-replacement its preamble — and each has to say so in its source
// map and compose the map of the layer beneath it, or a stack lands lines
// off, and click-to-component and `react-x11 dev`'s error window open the
// wrong place. The fixture runs under the real register entry, as an app
// does, so this fails on a hot-module-replacement older than 4.0.2 as well
// as on a loader that stops shifting its own map.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as nodeModule from 'node:module';
import { fileURLToPath } from 'node:url';

const supported = typeof nodeModule.registerHooks === 'function';
const register = fileURLToPath(
  new URL('../src/refresh/register.js', import.meta.url),
);
const entry = fileURLToPath(
  new URL('./fixtures/refresh-stack/entry.jsx', import.meta.url),
);

test(
  'a throw in a hot module is reported at its own line and column',
  { skip: supported ? false : 'module.registerHooks needs Node >= 22.15' },
  () => {
    const { stdout, stderr, status } = spawnSync(
      process.execPath,
      ['--enable-source-maps', '--import', register, entry],
      { encoding: 'utf8' },
    );
    assert.strictEqual(status, 0, stderr);
    // `new Error` on line 7 of the module that threw, and the call on line
    // 4 of the entry, which both layers transform too
    assert.match(stdout, /thrower\.jsx:7:9\)/);
    assert.match(stdout, /entry\.jsx:4:11\)?$/m);
  },
);

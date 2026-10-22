// `react-x11 help` (src/cli/env.js): the list of REACT_X11_* variables is
// written by hand, so it is held to src/ here — every name read there is
// listed, and every name listed is still read — and the bin prints it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENVIRONMENT, formatEnvironment } from '../src/cli/env.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const bin = join(repo, 'src/cli/index.js');

function sources(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return p.endsWith('.js') ? [p] : [];
  });
}

// Not preceded by an identifier character, which leaves out the X property
// `_REACT_X11_TIMESTAMP` (src/inputtime.js) — a name on the server, not in
// the environment.
const NAME = /(?<![\w$])REACT_X11_[A-Z0-9_]*[A-Z0-9]/g;

const listed = ENVIRONMENT.flatMap((group) => group.vars.map((v) => v.name));

test('every REACT_X11_* variable src/ reads is listed, and only those', () => {
  const read = new Set();
  for (const file of sources(join(repo, 'src'))) {
    if (file.endsWith(join('cli', 'env.js'))) continue;
    for (const [name] of readFileSync(file, 'utf8').matchAll(NAME)) {
      read.add(name);
    }
  }
  const missing = [...read].filter((name) => !listed.includes(name));
  assert.deepEqual(missing, [], 'read in src/ but not in src/cli/env.js');
  const stale = listed.filter((name) => !read.has(name));
  assert.deepEqual(stale, [], 'in src/cli/env.js but read nowhere in src/');
  assert.equal(new Set(listed).size, listed.length, 'listed twice');
});

test('the list wraps to the width it is given', () => {
  for (const width of [60, 80, 100]) {
    const long = formatEnvironment(width)
      .split('\n')
      .filter((line) => line.length > width && line.includes(' ', 6));
    assert.deepEqual(long, [], `lines over ${width} columns`);
  }
});

// eslint-disable-next-line no-control-regex
const SGR = /\x1b\[[\d;]*m/g;

test('colour adds escapes and nothing else', () => {
  const plain = formatEnvironment(80);
  const coloured = formatEnvironment(80, { color: true });
  assert.doesNotMatch(plain, SGR);
  assert.equal(coloured.replace(SGR, ''), plain);
  assert.ok(coloured.includes('\n\x1b[1mBackend and display\x1b[22m\n'));
  assert.ok(
    coloured.includes(
      '  \x1b[1;36mREACT_X11_BACKEND\x1b[39;22m' +
        '\x1b[2m=x11|cocoa|wayland|win32|auto\x1b[22m\n',
    ),
  );
  // a name with no value form is the name alone
  assert.ok(
    coloured.includes('  \x1b[1;36mREACT_X11_DEVTOOLS_SESSION\x1b[39;22m\n'),
  );
});

/** The bin, into a pipe, with the colour variables the test is given. */
function cli(args, env = {}) {
  const base = { ...process.env };
  delete base.FORCE_COLOR;
  delete base.NO_COLOR;
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    env: { ...base, ...env },
  });
}

test('react-x11 help prints the usage, then every variable', () => {
  const { status, stdout } = cli(['help']);
  assert.equal(status, 0);
  assert.match(stdout, /^Usage: react-x11 dev <file>/);
  assert.match(stdout, /\nEnvironment variables:\n/);
  for (const name of listed) assert.ok(stdout.includes(`  ${name}`), name);
  // a pipe gets no colour unless FORCE_COLOR asks for it
  assert.doesNotMatch(stdout, SGR);
  assert.match(cli(['help'], { FORCE_COLOR: '1' }).stdout, SGR);
  assert.doesNotMatch(cli(['help'], { FORCE_COLOR: '0' }).stdout, SGR);

  // --help stays the short form.
  const short = cli(['--help']);
  assert.equal(short.status, 0);
  assert.doesNotMatch(short.stdout, /Environment variables/);
});

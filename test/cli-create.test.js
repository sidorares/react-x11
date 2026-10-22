// `react-x11 create <dir>` and its alias, `npm create react-x11 <dir>`
// (src/cli/create.js, src/cli/create-react-x11/). The apps are written into
// test/fixtures, inside this repo, so that the one the test mounts resolves
// react from it the way an installed app resolves its own.
import { after, afterEach, test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PNG } from 'pngjs';
import React from 'react';
import {
  CreateError,
  appFiles,
  createApp,
  packageManagerOf,
  packageNameFor,
} from '../src/cli/create.js';
import {
  cleanup,
  fireEvent,
  renderX11,
  waitFor,
} from '../src/testing/index.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const own = createRequire(import.meta.url)('../package.json');
const scratch = mkdtempSync(join(repo, 'test/fixtures/create-run-'));
const quiet = { log: () => {} };

afterEach(() => cleanup());
after(() => rmSync(scratch, { recursive: true, force: true }));

function cli(argv, env = {}) {
  return spawnSync(process.execPath, argv, {
    cwd: scratch,
    encoding: 'utf8',
    env: { ...process.env, npm_config_user_agent: '', ...env },
  });
}

test('writes an app named after its directory, on react-x11’s own versions', () => {
  const dir = createApp(join(scratch, 'My App'), { ...quiet, install: false });
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  assert.strictEqual(pkg.name, 'my-app');
  assert.strictEqual(pkg.type, 'module');
  assert.strictEqual(pkg.dependencies['react-x11'], `^${own.version}`);
  assert.strictEqual(pkg.dependencies.react, own.peerDependencies.react);
  // the hot-reload toolchain is there already, so `dev` does not stop to ask
  for (const name of [
    '@babel/core',
    '@babel/plugin-transform-react-jsx',
    'hot-module-replacement',
    'react-refresh',
  ]) {
    assert.strictEqual(pkg.devDependencies[name], own.peerDependencies[name]);
  }
  assert.strictEqual(pkg.scripts.dev, 'react-x11 dev src/App.jsx');
  for (const file of [
    'src/App.jsx',
    'src/main.jsx',
    'README.md',
    '.gitignore',
    'AGENTS.md',
    'CLAUDE.md',
    'DESIGN.md',
  ]) {
    assert.ok(existsSync(join(dir, file)), file);
  }
  assert.match(
    readFileSync(join(dir, 'src/App.jsx'), 'utf8'),
    /<window title="My App"/,
  );
});

test('the app it writes mounts, and its button counts', async () => {
  const dir = createApp(join(scratch, 'counter'), { ...quiet, install: false });
  const { default: App } = await import(
    pathToFileURL(join(dir, 'src/App.jsx')).href
  );
  const { getByText } = await renderX11(React.createElement(App));
  getByText('Hello from react-x11');
  fireEvent.click(getByText('Clicked 0 times'));
  await waitFor(() => getByText('Clicked 1 times'));
});

test('AGENTS.md and DESIGN.md are filled in for this version', () => {
  const files = appFiles({ name: 'x', manager: 'bun' });
  const agents = files['AGENTS.md'];
  assert.match(agents, /^<!-- BEGIN:react-x11-agent-rules -->\n/);
  assert.match(agents, /\n<!-- END:react-x11-agent-rules -->\n/);
  assert.ok(agents.includes(`react-x11\n${own.version}.`), 'names the version');
  assert.ok(agents.includes(`/tree/v${own.version}/examples`), 'pins examples');
  assert.match(agents, /`bun start` runs the app once/);
  assert.match(files['DESIGN.md'], /^# Design\n/);
  assert.strictEqual(files['CLAUDE.md'], '@AGENTS.md\n');
  for (const [file, text] of Object.entries(files)) {
    assert.doesNotMatch(text, /\{\{\w+\}\}/, `${file} has a hole left in it`);
  }
  // the starter follows the rules it ships with: no colour but a token
  assert.doesNotMatch(files['src/App.jsx'], /#[0-9a-f]{3,8}\b/i);
});

test('--no-agents-md leaves the agent files out, and keeps DESIGN.md', () => {
  const made = cli([
    join(repo, 'src/cli/index.js'),
    'create',
    'no-agents',
    '--no-install',
    '--no-agents-md',
  ]);
  assert.strictEqual(made.status, 0, made.stderr);
  const dir = join(scratch, 'no-agents');
  assert.ok(!existsSync(join(dir, 'AGENTS.md')));
  assert.ok(!existsSync(join(dir, 'CLAUDE.md')));
  assert.ok(existsSync(join(dir, 'DESIGN.md')));
  assert.doesNotMatch(readFileSync(join(dir, 'README.md'), 'utf8'), /AGENTS/);
});

test('every page and file AGENTS.md points at ships in the package', () => {
  const agents = appFiles({ name: 'x' })['AGENTS.md'];
  const table = agents.slice(
    agents.indexOf('**Docs**'),
    agents.indexOf('**Types**'),
  );
  const pages = [...table.matchAll(/`([\w/*-]+\.md)`/g)].map((m) => m[1]);
  assert.ok(pages.length > 10, `only ${pages.length} pages found`);
  for (const page of pages) {
    const [dir, file] = page.includes('/') ? page.split('/') : ['', page];
    const present =
      file === '*.md'
        ? readdirSync(join(repo, 'docs', dir)).some((f) => f.endsWith('.md'))
        : existsSync(join(repo, 'docs', dir, file));
    assert.ok(present, `docs/${page} is named in AGENTS.md but missing`);
  }
  // `files` is what puts them under node_modules: the top level and one down
  assert.ok(own.files.includes('docs/*.md'));
  assert.ok(own.files.includes('docs/*/*.md'));
  for (const types of ['src/index.d.ts', 'src/types/elements.d.ts']) {
    assert.ok(existsSync(join(repo, types)), types);
  }
  const examples = [...agents.matchAll(/`(\w+\.jsx)`/g)].map((m) => m[1]);
  assert.ok(examples.length > 5);
  for (const example of examples) {
    assert.ok(existsSync(join(repo, 'examples', example)), example);
  }
});

test('the screenshot test AGENTS.md hands out runs, in both schemes', () => {
  const dir = createApp(join(scratch, 'pictures'), {
    ...quiet,
    install: false,
  });
  // the block as an agent would copy it out of the numbered list
  const agents = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
  const block = /\n {3}```jsx\n([\s\S]*?)\n {3}```\n/.exec(agents)[1];
  const source = block.replace(/^ {3}/gm, '');
  mkdirSync(join(dir, 'test'));
  writeFileSync(join(dir, 'test/App.test.jsx'), source);
  // installed the way npm would: react-x11 in the app's own node_modules
  mkdirSync(join(dir, 'node_modules'));
  symlinkSync(repo, join(dir, 'node_modules/react-x11'), 'junction');

  const ran = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--test', 'test/App.test.jsx'],
    {
      cwd: dir,
      encoding: 'utf8',
      // a run of its own, not a child reporting to this one
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    },
  );
  assert.strictEqual(ran.status, 0, ran.stdout + ran.stderr);
  // the picture is the window, edge to edge: the size it came out, and a
  // background of the scheme asked for all the way to the bottom corner
  const corners = {};
  for (const scheme of ['light', 'dark']) {
    const png = PNG.sync.read(readFileSync(join(dir, `shots/${scheme}.png`)));
    assert.ok(
      png.width > 200 && png.height > 100,
      `${png.width}x${png.height}`,
    );
    const at = (png.width * png.height - 1) * 4;
    corners[scheme] = png.data[at] + png.data[at + 1] + png.data[at + 2];
  }
  assert.ok(
    corners.light > corners.dark + 300,
    `light ${corners.light}, dark ${corners.dark}`,
  );
});

test('installs with the package manager that launched it', () => {
  const runs = [];
  const run = (argv, cwd) => (runs.push({ argv, cwd }), 0);
  const dir = createApp(join(scratch, 'installed'), {
    ...quiet,
    manager: 'pnpm',
    run,
  });
  assert.deepStrictEqual(runs, [{ argv: ['pnpm', 'install'], cwd: dir }]);
  assert.strictEqual(packageManagerOf('pnpm/9.1.0 npm/? node/v22'), 'pnpm');
  assert.strictEqual(packageManagerOf('yarn/4.0.0 npm/? node/v22'), 'yarn');
  assert.strictEqual(packageManagerOf(undefined), 'npm');
  assert.match(
    appFiles({ name: 'x', manager: 'bun' })['README.md'],
    /`bun dev`/,
  );
});

test('a failed install says the files are written', () => {
  assert.throws(
    () => createApp(join(scratch, 'failed'), { ...quiet, run: () => 1 }),
    (err) =>
      err instanceof CreateError &&
      /`npm install` failed \(exit 1\)/.test(err.message) &&
      /files are written/.test(err.message),
  );
});

test('refuses a directory with something in it, not one with only .git', () => {
  const busy = join(scratch, 'busy');
  mkdirSync(busy);
  writeFileSync(join(busy, 'notes.txt'), '');
  assert.throws(
    () => createApp(busy, { ...quiet, install: false }),
    (err) =>
      err instanceof CreateError &&
      /not empty \(notes\.txt\)/.test(err.message),
  );
  const fresh = join(scratch, 'fresh');
  mkdirSync(join(fresh, '.git'), { recursive: true });
  createApp(fresh, { ...quiet, install: false });
  assert.ok(existsSync(join(fresh, 'package.json')));
});

test('package names come out valid, or not at all', () => {
  assert.strictEqual(packageNameFor('My Cool_App!'), 'my-cool_app');
  assert.strictEqual(packageNameFor('.hidden'), 'hidden');
  assert.strictEqual(packageNameFor('!!!'), null);
});

test('react-x11 create, through the real bin', () => {
  const bin = join(repo, 'src/cli/index.js');
  const made = cli([bin, 'create', 'from-bin', '--no-install']);
  assert.strictEqual(made.status, 0, made.stderr);
  assert.match(made.stdout, /cd from-bin\n {2}npm install\n {2}npm run dev/);
  assert.ok(existsSync(join(scratch, 'from-bin/src/App.jsx')));

  const none = cli([bin, 'create']);
  assert.strictEqual(none.status, 2);
  assert.match(none.stderr, /react-x11 create: which directory\?/);
  const flag = cli([bin, 'create', 'x', '--yes']);
  assert.strictEqual(flag.status, 2);
  assert.match(flag.stderr, /no option --yes/);
  const again = cli([bin, 'create', 'from-bin', '--no-install']);
  assert.strictEqual(again.status, 1);
  assert.match(again.stderr, /from-bin is not empty/);
});

test('create-react-x11 is the same command, installed beside react-x11', () => {
  // laid out the way npm installs it: the alias, with react-x11 next to it
  const prefix = join(scratch, 'npx');
  const alias = join(prefix, 'node_modules/create-react-x11');
  mkdirSync(alias, { recursive: true });
  for (const file of ['index.js', 'package.json']) {
    copyFileSync(
      join(repo, 'src/cli/create-react-x11', file),
      join(alias, file),
    );
  }
  symlinkSync(repo, join(prefix, 'node_modules/react-x11'), 'junction');

  const made = cli([join(alias, 'index.js'), 'from-alias', '--no-install']);
  assert.strictEqual(made.status, 0, made.stderr);
  assert.ok(existsSync(join(scratch, 'from-alias/src/App.jsx')));
  const none = cli([join(alias, 'index.js')]);
  assert.strictEqual(none.status, 2);
  assert.match(none.stderr, /^create-react-x11: which directory\?/);
  assert.match(none.stderr, /Usage: create-react-x11 <dir>/);
});

test('the alias is not part of the react-x11 package', () => {
  assert.ok(own.files.includes('!src/cli/create-react-x11'));
  const alias = JSON.parse(
    readFileSync(join(repo, 'src/cli/create-react-x11/package.json'), 'utf8'),
  );
  assert.strictEqual(alias.bin['create-react-x11'], './index.js');
  assert.ok('react-x11' in alias.dependencies);
});

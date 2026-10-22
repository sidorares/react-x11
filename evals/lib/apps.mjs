// Making the app a cell starts from: react-x11 packed from the checkout
// under test, `react-x11 create`, the variant's context files, an install.
import { spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { EVALS, childEnv, gitInfo, readJSON, sh, sha256 } from './common.mjs';

export const CONTEXT_FILES = ['AGENTS.md', 'CLAUDE.md', 'DESIGN.md'];

/**
 * `npm pack` of the checkout, so every app installs exactly the react-x11
 * under test, docs/ included (the npm release may not ship them yet), and
 * the version recorded is the one that ran.
 */
export function packReactX11(repo, dest) {
  mkdirSync(dest, { recursive: true });
  const r = sh('npm', ['pack', '--json', '--pack-destination', dest], {
    cwd: repo,
    env: childEnv(),
  });
  if (r.status !== 0)
    throw new Error(`npm pack in ${repo} failed:\n${r.stderr}`);
  const [info] = JSON.parse(r.stdout.slice(r.stdout.indexOf('[')));
  const tarball = join(dest, info.filename);
  return {
    tarball,
    version: info.version,
    sha256: sha256(readFileSync(tarball)),
    files: info.entryCount,
    hasDocs: info.files.some((f) => f.path.startsWith('docs/')),
    git: gitInfo(repo),
  };
}

const createHelp = new Map();
function createSupports(repo, flag) {
  if (!createHelp.has(repo)) {
    const r = sh('node', [join(repo, 'src/cli/index.js'), 'create', '--help'], {
      env: childEnv(),
    });
    createHelp.set(repo, `${r.stdout}${r.stderr}`);
  }
  return createHelp.get(repo).includes(flag);
}

/**
 * `react-x11 create`, then only the variant's context files: whatever create
 * wrote of AGENTS.md, CLAUDE.md and DESIGN.md goes, the variant's come in,
 * and a README paragraph pointing at a file the arm does not have goes too.
 * An arm with AGENTS.md is created with it, so create-default's README is
 * exactly create's.
 */
export function createApp({ repo, dir, tarball, variant }) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(resolve(dir, '..'), { recursive: true });
  const args = [join(repo, 'src/cli/index.js'), 'create', dir, '--no-install'];
  const wantsAgents = 'AGENTS.md' in variant.files;
  if (!wantsAgents && createSupports(repo, '--no-agents-md'))
    args.push('--no-agents-md');
  const r = sh('node', args, { env: childEnv() });
  if (r.status !== 0)
    throw new Error(`react-x11 create failed:\n${r.stdout}${r.stderr}`);

  const written = {};
  for (const f of CONTEXT_FILES) {
    const p = join(dir, f);
    if (existsSync(p)) {
      written[f] = readFileSync(p, 'utf8');
      rmSync(p);
    }
  }
  for (const [f, text] of Object.entries(variant.files))
    writeFileSync(join(dir, f), text);

  const readme = join(dir, 'README.md');
  if (existsSync(readme)) {
    const missing = CONTEXT_FILES.filter((f) => !(f in variant.files));
    const kept = readFileSync(readme, 'utf8')
      .split(/\n\n/)
      .filter((para) => !missing.some((f) => para.includes(`(${f})`)));
    writeFileSync(readme, `${kept.join('\n\n').trimEnd()}\n`);
  }

  const pkgFile = join(dir, 'package.json');
  const pkg = readJSON(pkgFile);
  if (tarball) pkg.dependencies['react-x11'] = `file:${tarball}`;
  writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
  return { createdWith: written, argv: args.slice(1) };
}

/** Whether this checkout's create writes what create-default holds. */
export function staleCreateDefault(createdWith, variant) {
  if (variant.name !== 'create-default') return [];
  return Object.keys(variant.files).filter(
    (f) => f in createdWith && createdWith[f] !== variant.files[f],
  );
}

export function npmInstall(dir, log) {
  const r = sh(
    'npm',
    [
      'install',
      '--prefer-offline',
      '--no-audit',
      '--no-fund',
      '--loglevel=error',
    ],
    {
      cwd: dir,
      env: childEnv(),
    },
  );
  if (log) writeFileSync(log, `${r.stdout}\n${r.stderr}`);
  return {
    ok: r.status === 0,
    ms: r.ms,
    status: r.status,
    tail: r.stderr.split('\n').slice(-15).join('\n'),
  };
}

/** Copy an app without what an install or a run makes. */
export function copyApp(from, to) {
  rmSync(to, { recursive: true, force: true });
  const r = sh('rsync', [
    '-a',
    '--exclude=node_modules',
    '--exclude=.git',
    '--exclude=shots',
    '--exclude=*.log',
    `${from}/`,
    `${to}/`,
  ]);
  if (r.status !== 0) {
    // no rsync: cp, then drop what it should have skipped
    mkdirSync(to, { recursive: true });
    const c = sh('cp', ['-a', `${from}/.`, to]);
    if (c.status !== 0) throw new Error(`copying ${from} failed: ${c.stderr}`);
    rmSync(join(to, 'node_modules'), { recursive: true, force: true });
  }
}

/**
 * Start a headless X display for one agent run (see xdisplay.mjs); resolves
 * to { display, stop }. `dir` is any installed app, for its node_modules/x11.
 */
export function startDisplay(dir) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      'node',
      [
        join(EVALS, 'lib/xdisplay.mjs'),
        dir,
        String(90 + Math.floor(Math.random() * 100)),
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    const lines = createInterface({ input: child.stdout });
    lines.once('line', (line) => {
      const display = line.replace(/^DISPLAY=/, '').trim();
      resolvePromise({ display, stop: () => child.kill('SIGKILL') });
    });
    child.once('exit', (code) =>
      reject(new Error(`headless display exited (${code}): ${err}`)),
    );
  });
}

export function copyInto(dir, files) {
  for (const [from, to] of files) {
    mkdirSync(resolve(join(dir, to), '..'), { recursive: true });
    copyFileSync(from, join(dir, to));
  }
}

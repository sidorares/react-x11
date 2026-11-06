// What every evals script shares: where things are, argument parsing,
// processes with a wall clock, hashes, and the versions a result is only
// meaningful next to.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  createWriteStream,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EVALS = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = resolve(EVALS, '..');

/**
 * Runs live outside the repository on purpose. Claude Code reads every
 * CLAUDE.md from the working directory up to /, and an agent that can see
 * react-x11's own source, examples and AGENTS.md is not measuring the arm it
 * was given.
 */
export const DEFAULT_OUT =
  process.env.REACT_X11_EVALS_OUT ??
  join(
    process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'),
    'react-x11-evals',
  );

/** `--key value`, `--key=value`, `--flag`, `--no-flag`; the rest positional. */
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (eq > 0) {
      out[camel(arg.slice(2, eq))] = arg.slice(eq + 1);
    } else if (arg.startsWith('--no-')) {
      out[camel(arg.slice(5))] = false;
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      out[camel(arg.slice(2))] = argv[++i];
    } else {
      out[camel(arg.slice(2))] = true;
    }
  }
  return out;
}

export const list = (value) =>
  value === undefined || value === true
    ? []
    : String(value)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

/** '15m', '90s', '2h', or milliseconds. */
export function duration(value, fallback) {
  if (value === undefined) return fallback;
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(String(value));
  if (!m) throw new Error(`not a duration: ${value}`);
  const unit = { ms: 1, s: 1e3, m: 60e3, h: 3600e3 }[m[2] ?? 'ms'];
  return Number(m[1]) * unit;
}

export const readJSON = (file, fallback) => {
  if (fallback !== undefined && !existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, 'utf8'));
};

export function writeJSON(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

export function sh(cmd, args, opts = {}) {
  const started = Date.now();
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 64 << 20,
    ...opts,
  });
  return {
    status: r.status,
    signal: r.signal,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    error: r.error?.message,
    ms: Date.now() - started,
  };
}

/**
 * A child process with a wall clock. It runs in a process group of its own,
 * so a timeout takes down what it started too (an `npm start` the agent left
 * running, a dev server), not only the agent.
 */
export function runProcess(
  cmd,
  args,
  { cwd, env, timeoutMs, stdout, stderr, input },
) {
  const started = Date.now();
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, {
      cwd,
      env,
      detached: true,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    const outs = [
      [child.stdout, stdout],
      [child.stderr, stderr],
    ];
    const captured = { stdout: '', stderr: '' };
    for (const [stream, file] of outs) {
      const key = stream === child.stdout ? 'stdout' : 'stderr';
      if (file) stream.pipe(createWriteStream(file));
      else stream.on('data', (d) => (captured[key] += d));
    }
    if (input !== undefined) child.stdin.end(input);
    let timedOut = false;
    const kill = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch {
        // the group is gone already
      }
    };
    const timer =
      timeoutMs &&
      setTimeout(() => {
        timedOut = true;
        kill('SIGTERM');
        setTimeout(() => kill('SIGKILL'), 10_000).unref();
      }, timeoutMs);
    const onExit = () => kill('SIGKILL');
    process.once('exit', onExit);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      process.removeListener('exit', onExit);
      // whatever the agent left running in its group goes with it
      kill('SIGKILL');
      resolvePromise({
        code,
        signal,
        timedOut,
        ms: Date.now() - started,
        ...captured,
      });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolvePromise({
        code: null,
        error: err.message,
        timedOut,
        ms: Date.now() - started,
      });
    });
  });
}

/** HEAD, its branch, and whether `paths` (or anything) has uncommitted changes. */
export function gitInfo(dir, paths = []) {
  const git = (...a) => sh('git', ['-C', dir, ...a]);
  const head = git('rev-parse', 'HEAD');
  if (head.status !== 0) return null;
  return {
    sha: head.stdout.trim(),
    branch: git('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim(),
    dirty: git('status', '--porcelain', '--', ...paths).stdout.trim() !== '',
  };
}

/**
 * The environment an agent or a grader child runs in: this one, minus what
 * marks it as a session of the desktop app that started the harness (a
 * nested session behaves differently, and must not talk to the app's
 * socket), minus the real display, so nothing opens a window on the desk.
 */
export function childEnv(extra = {}) {
  const keep = new Set([
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CONFIG_DIR',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
  ]);
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^CLAUDE/.test(k) && !keep.has(k)) continue;
    if (
      /^(npm_|ELECTRON_|AI_AGENT$|BAGGAGE$|GIO_LAUNCHED|CHROME_DESKTOP$)/.test(
        k,
      )
    )
      continue;
    if (/^(DISPLAY|WAYLAND_DISPLAY|XAUTHORITY)$/.test(k)) continue;
    env[k] = v;
  }
  env.NO_AT_BRIDGE = '1';
  return { ...env, ...extra };
}

/** The Claude Code binary: $CLAUDE_BIN, `claude` on PATH, or the one the
 * desktop app ships, newest first. */
export function findClaude() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  if (sh('sh', ['-c', 'command -v claude']).status === 0) return 'claude';
  const candidates = [];
  const desktop = join(homedir(), '.config/Claude/claude-code');
  if (existsSync(desktop)) {
    for (const version of readdirSync(desktop)) {
      const vdir = join(desktop, version);
      if (!statSync(vdir).isDirectory()) continue;
      for (const build of readdirSync(vdir)) {
        const bin = join(vdir, build, 'claude');
        if (existsSync(bin))
          candidates.push({ bin, mtime: statSync(bin).mtimeMs });
      }
    }
  }
  for (const bin of [
    join(homedir(), '.claude/local/claude'),
    join(homedir(), '.local/bin/claude'),
  ]) {
    if (existsSync(bin)) candidates.push({ bin, mtime: statSync(bin).mtimeMs });
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.bin ?? null;
}

/** Every file under `dir` (relative paths), skipping what is not source. */
export function walk(
  dir,
  { skip = /^(node_modules|\.git|shots|dist|build)$/ } = {},
) {
  const out = [];
  (function go(rel) {
    const abs = join(dir, rel);
    for (const name of readdirSync(abs)) {
      if (skip.test(name)) continue;
      const r = rel ? `${rel}/${name}` : name;
      const st = statSync(join(dir, r), { throwIfNoEntry: false });
      if (!st) continue;
      if (st.isDirectory()) go(r);
      else out.push(r);
    }
  })('');
  return out;
}

export function loadPrompts(which) {
  const index = readJSON(join(EVALS, 'prompts/index.json'));
  const all = [
    ...index.dev.map((p) => ({ ...p, set: 'dev' })),
    ...index.test.map((p) => ({ ...p, set: 'test' })),
  ];
  const wanted = list(which ?? 'dev');
  const picked = all.filter(
    (p) =>
      wanted.includes(p.set) ||
      wanted.includes(p.id) ||
      wanted.includes(p.archetype),
  );
  const unknown = wanted.filter(
    (w) => !all.some((p) => p.set === w || p.id === w || p.archetype === w),
  );
  if (unknown.length)
    throw new Error(`no prompt or set named ${unknown.join(', ')}`);
  return picked.map((p) => ({
    ...p,
    text: readFileSync(
      join(EVALS, 'prompts', p.set, `${p.id}.txt`),
      'utf8',
    ).trim(),
    checklist: readFileSync(
      join(EVALS, 'prompts/checklists', `${p.id}.md`),
      'utf8',
    ).trim(),
  }));
}

export function loadVariant(name) {
  const dir = join(EVALS, 'variants', name);
  if (!existsSync(join(dir, 'variant.json'))) {
    const known = readdirSync(join(EVALS, 'variants')).filter((d) =>
      existsSync(join(EVALS, 'variants', d, 'variant.json')),
    );
    throw new Error(`no variant ${name} (have: ${known.join(', ')})`);
  }
  const meta = readJSON(join(dir, 'variant.json'));
  const files = Object.fromEntries(
    (meta.files ?? []).map((f) => [f, readFileSync(join(dir, f), 'utf8')]),
  );
  return { name, dir, ...meta, files, sha256: sha256(JSON.stringify(files)) };
}

/** A seeded PRNG (mulberry32), so a judge's coin flips can be replayed. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function fail(message) {
  console.error(`\n\x1b[1;31m✗ ${message}\x1b[0m\n`);
  process.exit(2);
}

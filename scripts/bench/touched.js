// Which benches does this change owe?
//
//   npm run bench:touched                     # against origin/master
//   npm run bench:touched -- --base=HEAD~3    # against another ref
//   npm run bench:touched -- --dry            # say which, run nothing
//   npm run bench:touched -- --benches=presenters --ci   # CI's macOS job
//   npm run bench:touched -- --all            # every bench, whatever changed
//
// A performance regression is a change to a hot path, and a hot path is a
// short list of files: the paint walk and the damage model, the layout
// floors, the paint cache, the event dispatch that decides when a frame
// goes out, the Cocoa frame clock and swapchain, the benches and their
// baselines themselves, and the dependency manifest, because an ntk bump
// moves everything under all of them. This script reads the diff against
// the base, matches it against that list, and runs the benches the matches
// owe — nothing for a docs change, the X11 protocol gate for a `nodes.js`
// change, the Cocoa frame-clock gate as well on a mac. The list is the
// policy, in one place, and it is deliberately short: a path that is not on
// it is a path a regression cannot reach without going through one that is.
//
// Every bench it runs is a gate someone can run by hand
// (`npm run bench -- --check`, `npm run bench:pixels -- --check`,
// `npm run bench:presenters -- --check`); this only decides which.
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const BASE = flag('base', process.env.BENCH_BASE ?? 'origin/master');
const DRY = args.includes('--dry');
const CI = args.includes('--ci');
const ALL = args.includes('--all');
const BENCHES = flag('benches', null)?.split(',') ?? null;

/**
 * The hot paths, per bench. `platform` names where the bench can run at
 * all — the Cocoa gate needs a mac with a window server, the X11 benches
 * run anywhere on the in-process server.
 */
const BENCHES_BY_NAME = {
  protocol: {
    what: 'X11 protocol efficiency (requests, bytes, composite pixels)',
    command: ['npm', ['run', 'bench', '--', '--check']],
    // the retry the CI job makes, for the per-scenario jitter protocol.js
    // describes: a real regression fails twice
    retry: true,
    paths: [
      /^src\/(nodes|node|paintcache|styles|decorations|svgnodes|events|frames|compositing|scale|yoga)\.js$/,
      /^src\/components\//,
      /^scripts\/bench\/(protocol|xcount)\.js$/,
      /^scripts\/bench\/baseline\.json$/,
      /^package(-lock)?\.json$/,
    ],
  },
  pixels: {
    what: 'X11 rendered pixels (hashes per scenario)',
    command: ['npm', ['run', 'bench:pixels', '--', '--check']],
    paths: [
      /^src\/(nodes|node|paintcache|styles|decorations|svgnodes|events|frames|compositing|scale|yoga)\.js$/,
      /^src\/components\//,
      /^scripts\/bench\/pixels\.js$/,
      /^scripts\/bench\/pixels-baseline\.json$/,
      /^package(-lock)?\.json$/,
    ],
  },
  presenters: {
    what: 'Cocoa frame clock and damage model (structural gate)',
    command: ['npm', ['run', 'bench:presenters', '--', '--check']],
    platform: 'darwin',
    paths: [
      /^src\/cocoa\//,
      /^src\/(nodes|node|paintcache|styles|events|frames|scale)\.js$/,
      /^scripts\/bench\/presenters(-gate\.json|\.js)$/,
      /^package(-lock)?\.json$/,
    ],
  },
};

function changedFiles(base) {
  const range = `${base}...HEAD`;
  const res = spawnSync('git', ['diff', '--name-only', range], {
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    throw new Error(
      `git diff ${range} failed: ${res.stderr.trim()} — pass --base=<ref> ` +
        'or fetch the base first',
    );
  }
  const committed = res.stdout.split('\n').filter(Boolean);
  // …plus whatever is not committed yet, which is what a developer asks about
  const working = spawnSync('git', ['status', '--porcelain'], {
    encoding: 'utf8',
  })
    .stdout.split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3).split(' -> ').pop());
  return [...new Set([...committed, ...working])];
}

const wanted = Object.entries(BENCHES_BY_NAME).filter(
  ([name, bench]) =>
    (!BENCHES || BENCHES.includes(name)) &&
    (!bench.platform || bench.platform === process.platform),
);

let files = [];
if (!ALL) {
  files = changedFiles(BASE);
}

const owed = [];
for (const [name, bench] of wanted) {
  const hits = ALL
    ? ['--all']
    : files.filter((f) => bench.paths.some((p) => p.test(f)));
  if (hits.length) owed.push({ name, bench, hits });
}

if (!ALL) {
  console.log(
    `${files.length} changed file${files.length === 1 ? '' : 's'} against ${BASE}`,
  );
}
if (!owed.length) {
  console.log('no hot path touched — no bench owed');
  process.exit(0);
}
for (const { name, bench, hits } of owed) {
  console.log(`\n${name}: ${bench.what}`);
  console.log(
    `  owed by ${hits.slice(0, 6).join(', ')}${hits.length > 6 ? ` and ${hits.length - 6} more` : ''}`,
  );
}
if (DRY) process.exit(0);

let failed = 0;
for (const { name, bench } of owed) {
  console.log(`\n=== ${name} ===`);
  const [cmd, cmdArgs] = bench.command;
  const argv = CI && name === 'presenters' ? [...cmdArgs, '--ci'] : cmdArgs;
  const run = () =>
    spawnSync(cmd, argv, { stdio: 'inherit', env: process.env }).status;
  let status = run();
  if (status !== 0 && bench.retry) {
    console.log(`\n${name} failed once — running it again`);
    status = run();
  }
  if (status !== 0) failed += 1;
}
if (failed) {
  console.log(`\n${failed} bench${failed === 1 ? '' : 'es'} failed`);
  process.exit(1);
}
console.log('\nevery owed bench holds');

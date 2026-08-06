// Measure this server's local-vs-server rasterization crossover, and print
// the policy that fits it.
//
//   npm run bench:raster                       # ~20s, the canonical grid
//   npm run bench:raster -- --full             # ~2min, 66 probes
//   npm run bench:raster -- --json out.json    # also write the raw samples
//   npm run bench:raster -- --label "glamor/virgl on M5"
//   npm run bench:raster -- --fills 4          # per-operation overhead too
//
// Needs $DISPLAY: the number this produces is a property of a *server*, and
// there is no way to learn it without one. It draws nothing on screen —
// everything goes into an offscreen pixmap (see examples/raster-gate/
// calibrate.js for why that is the representative drawable).
//
// The output ends with a policy you can paste:
//
//   root.app.options.rasterPolicy = { maxArea: …, bytesPerEdge: … };
//
// ## Reading the table
//
// Each row is one probe: a star of `tri` triangles filling a `size` box.
// `local` and `server` are milliseconds per drawing with the policy pinned
// each way, `win` names the faster one and by how much. What you are looking
// for is where `win` flips — that column is the crossover the two thresholds
// are trying to describe.
//
// `issue` is the client half (building and writing the requests); the rest of
// `total` is the server draining them. On a software server the two are
// comparable. On glamor the server column is where a rounded corner goes to
// die, and the local route's job is to keep the shape away from it.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { createClient } from 'ntk';

import {
  GRID,
  GRID_FULL,
  fitPolicy,
  platform,
  sweep,
} from '../../examples/raster-gate/calibrate.js';
import { NTK_DEFAULT, routeRaster } from '../../examples/raster-gate/probe.js';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

if (flag('help')) {
  console.log(
    readFileSync(new URL(import.meta.url), 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('//'))
      .map((l) => l.replace(/^\/\/ ?/, ''))
      .join('\n'),
  );
  process.exit(0);
}

const grid = flag('full') ? GRID_FULL : GRID;
const trials = Number(value('trials', 3));
const fills = Number(value('fills', 1));
const surface = Number(value('surface', 0));
const jsonPath = value('json');
const label = value('label');

/** The GL renderer string, when the machine has glxinfo. This is the single
 * most predictive fact about the answer — "llvmpipe" and "virgl" and a real
 * GPU give three different crossovers — and it is not reachable through the
 * X connection, so it is scraped here rather than in calibrate.js, which has
 * no business spawning processes. */
function glRenderer() {
  try {
    const out = execFileSync('glxinfo', ['-B'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    const device = out.match(/^\s*Device:\s*(.+)$/m)?.[1];
    const renderer = out.match(/^OpenGL renderer string:\s*(.+)$/m)?.[1];
    return (device ?? renderer ?? '').trim() || null;
  } catch {
    return null;
  }
}

/** ntk's version, read off disk: its exports map allows `.` only, so
 * `require('ntk/package.json')` is not a thing. */
function ntkVersion() {
  try {
    const require = createRequire(import.meta.url);
    const path = require
      .resolve('ntk')
      .replace(/lib[/\\]index\.js$/, 'package.json');
    return JSON.parse(readFileSync(path, 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

const ms = (v) => v.toFixed(3).padStart(8);
const pad = (v, n) => String(v).padStart(n);

const app = await createClient();
const env = { ...platform(app), ntk: ntkVersion(), gl: glRenderer(), label };

console.log(
  `raster sweep — ${env.os}, node ${env.node}, ntk ${env.ntk ?? '?'}\n` +
    `  server   ${env.vendor ?? '?'}${env.release ? ` r${env.release}` : ''}` +
    ` on ${env.display ?? '?'}` +
    ` (${env.localSocket ? 'local socket' : 'tcp'})\n` +
    (env.gl ? `  gl       ${env.gl}\n` : '') +
    (label ? `  label    ${label}\n` : '') +
    `  grid     ${grid.sizes.length}x${grid.triangles.length} probes,` +
    ` ${trials} trials, ${fills} fill${fills === 1 ? '' : 's'} per sample` +
    (surface ? `, ${surface}px drawable` : ''),
);
console.log(
  '\n  size   tri    area   edges  area/edge     local    server   win\n' +
    '  ────────────────────────────────────────────────────────────────────',
);

const result = await sweep(app, {
  grid,
  trials,
  fills,
  surface,
  onProgress({ sample: s }) {
    const faster = s.local.totalMs <= s.server.totalMs ? 'local' : 'server';
    const factor =
      Math.max(s.local.totalMs, s.server.totalMs) /
      Math.max(1e-6, Math.min(s.local.totalMs, s.server.totalMs));
    console.log(
      `  ${pad(s.size, 4)}  ${pad(s.triangles, 4)}  ${pad(s.area, 6)}  ` +
        `${pad(s.edges, 6)}  ${pad(Math.round(s.ratio), 9)}  ` +
        `${ms(s.local.totalMs)}  ${ms(s.server.totalMs)}  ` +
        `${faster} ${factor.toFixed(1)}x`,
    );
  },
});

const fit = fitPolicy(result.samples);
const { policy, totals } = fit;

// how much of each route's time was the client, averaged — the "is this
// machine's problem the client or the server" line
const share = (pick) => {
  const rows = result.samples.map(pick);
  const total = rows.reduce((s, r) => s + r.totalMs, 0);
  const issue = rows.reduce((s, r) => s + r.issueMs, 0);
  return total > 0 ? issue / total : 0;
};

console.log(
  `\n  client share of the time: local ${(share((s) => s.local) * 100).toFixed(0)}%,` +
    ` server ${(share((s) => s.server) * 100).toFixed(0)}%`,
);

console.log(
  `\n  totals over the grid (ms of drawing, lower is better)\n` +
    `    ntk default   ${totals.ntkDefault.toFixed(2)}\n` +
    `    all local     ${totals.allLocal.toFixed(2)}\n` +
    `    all server    ${totals.allServer.toFixed(2)}\n` +
    `    fitted        ${totals.fitted.toFixed(2)}   ` +
    `${fit.speedup.toFixed(2)}x the default\n` +
    `    (oracle)      ${totals.oracle.toFixed(2)}   ` +
    `fit is ${((fit.headroom - 1) * 100).toFixed(1)}% above the best possible routing`,
);

// `Infinity` is a legitimate answer — "every drawing measured wanted this
// route" — and it is also what JSON cannot hold, so it is spelled out here
// and stringified in the file.
const num = (v) => (Number.isFinite(v) ? String(v) : 'Infinity');
const ceiling =
  policy.maxBytes === NTK_DEFAULT.maxBytes
    ? ''
    : `, maxBytes: ${num(policy.maxBytes)}`;
console.log(
  `\n  fitted policy — agrees with ${(fit.agreement * 100).toFixed(0)}% of the probes\n\n` +
    `    root.app.options.rasterPolicy = { maxArea: ${num(policy.maxArea)}, ` +
    `bytesPerEdge: ${num(policy.bytesPerEdge)}${ceiling} };\n\n` +
    `  ntk's default is { maxArea: ${NTK_DEFAULT.maxArea}, ` +
    `bytesPerEdge: ${NTK_DEFAULT.bytesPerEdge} }`,
);

// The one-line verdict. Which side the fit lands on is the thing worth
// comparing across machines, and it is not obvious from two numbers: a large
// maxArea and a large bytesPerEdge both mean "keep it local", but so does a
// large maxArea with a small bytesPerEdge if nothing in the grid is big.
const localShare =
  result.samples.filter(
    (s) => routeRaster(s.width, s.height, s.edges, policy) === 'local',
  ).length / result.samples.length;
console.log(
  `  it routes ${(localShare * 100).toFixed(0)}% of this grid local` +
    ` (ntk's default routes ${(
      (result.samples.filter(
        (s) => routeRaster(s.width, s.height, s.edges, NTK_DEFAULT) === 'local',
      ).length /
        result.samples.length) *
      100
    ).toFixed(0)}%)`,
);

if (jsonPath) {
  writeFileSync(
    jsonPath,
    `${JSON.stringify(
      { env, ...result, fit },
      // JSON has no Infinity — it would serialize as null and read back as
      // "no threshold given", which is the opposite of what it means here
      (_key, v) =>
        typeof v === 'number' && !Number.isFinite(v) ? 'Infinity' : v,
      2,
    )}\n`,
  );
  console.log(`\n  wrote ${jsonPath}`);
}

process.exit(0);

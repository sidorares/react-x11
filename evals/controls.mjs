#!/usr/bin/env node
// The harness checking itself. evals/controls/ holds one file browser built
// well (adapted from examples/finder.jsx) and the same app built the ways
// DESIGN.md calls a website: hard-coded colours, card soup, stretched
// buttons, a hero header. The grader must rank the good one above each bad
// one, and catch each bad one's flaw by the rule meant for it; the judge,
// shown the pair in both orders, must pick the good one every time. If not,
// a metric is broken and every number it produced is suspect, so this fails
// loudly instead of reporting.
//
//   node evals/controls.mjs [--judge] [--repo <react-x11 checkout>] [--out <dir>]
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { copyApp, createApp, npmInstall, packReactX11 } from './lib/apps.mjs';
import {
  DEFAULT_OUT,
  EVALS,
  REPO,
  fail,
  parseArgs,
  readJSON,
  writeJSON,
} from './lib/common.mjs';
import { gradeApp } from './grade.mjs';
import { judgePair } from './lib/judgepair.mjs';

export const CONTROL_PROMPT = {
  id: 'control-files',
  text: 'Build a file browser: a sidebar of places, the files in the selected place with their kind, size and date, search, and a way to open and delete files.',
  checklist: [
    '- A sidebar of places, one selected.',
    '- The files of that place with name, kind, size and date, aligned in columns.',
    '- A search field.',
    '- Open and delete are reachable (menu, toolbar or context menu).',
  ].join('\n'),
};

export function listControls() {
  return readdirSync(join(EVALS, 'controls'))
    .filter((d) => existsSync(join(EVALS, 'controls', d, 'control.json')))
    .map((name) => ({
      name,
      dir: join(EVALS, 'controls', name),
      ...readJSON(join(EVALS, 'controls', name, 'control.json')),
    }));
}

/** An installed app to graft each control's App.jsx onto, kept per tarball. */
function baseApp({ out, tarball, repo }) {
  const dir = join(out, 'controls', 'base', 'app');
  const stamp = join(out, 'controls', 'base', 'stamp.json');
  if (
    readJSON(stamp, {}).tarball === tarball &&
    existsSync(join(dir, 'node_modules/react-x11'))
  )
    return dir;
  createApp({ repo, dir, tarball, variant: { name: 'none', files: {} } });
  const install = npmInstall(dir, join(out, 'controls', 'base', 'install.log'));
  if (!install.ok)
    throw new Error(
      `controls: installing the base app failed:\n${install.tail}`,
    );
  writeJSON(stamp, { tarball });
  return dir;
}

/** Grade every control; returns the grades and the problems found. */
export async function gradeControls({
  out = DEFAULT_OUT,
  repo = REPO,
  tarball,
} = {}) {
  const pack = tarball
    ? { tarball }
    : packReactX11(repo, join(out, 'controls', 'pkg'));
  const base = baseApp({ out, tarball: pack.tarball, repo });
  const grades = {};
  for (const c of listControls()) {
    const work = join(out, 'controls', c.name);
    rmSync(work, { recursive: true, force: true });
    const app = join(work, 'app');
    copyApp(base, app);
    copyFileSync(join(c.dir, 'App.jsx'), join(app, 'src/App.jsx'));
    grades[c.name] = {
      ...c,
      ...(await gradeApp({
        app,
        work: join(work, 'grade'),
        shots: join(work, 'shots'),
        nodeModules: join(base, 'node_modules'),
      })),
    };
  }
  const problems = [];
  const good = Object.values(grades).filter((g) => g.expect === 'good');
  const bad = Object.values(grades).filter((g) => g.expect === 'bad');
  if (!good.length || !bad.length)
    problems.push('controls: need at least one good and one bad control');
  for (const g of good) {
    if (!g.pass)
      problems.push(
        `${g.name} (good) fails a gate: ${JSON.stringify(g.gates)} ${g.details.smokeErrors.light ?? ''}`,
      );
    if (g.violations > 0) {
      problems.push(
        `${g.name} (good) breaks ${Object.entries(g.rules)
          .filter(([, v]) => v === false)
          .map(([k]) => k)
          .join(', ')}`,
      );
    }
    for (const b of bad) {
      const above = g.pass && (!b.pass || b.violations > g.violations);
      if (!above)
        problems.push(
          `grader ranks ${b.name} (${b.violations} broken) not below ${g.name} (${g.violations} broken)`,
        );
    }
  }
  for (const b of bad) {
    if (!b.pass)
      problems.push(
        `${b.name} should mount and fail on style, not on a gate: ${JSON.stringify(b.gates)} ${b.details.smokeErrors.light ?? ''}`,
      );
    for (const rule of b.catches ?? []) {
      if (b.rules[rule] !== false)
        problems.push(`${b.name}: the ${rule} rule did not catch ${b.flaw}`);
    }
  }
  return { grades, problems, tarball: pack.tarball };
}

/** Good beats each bad, in both orders, every time. */
export async function judgeControls({ grades, judgePair, model, out }) {
  const problems = [];
  const verdicts = [];
  const good = Object.values(grades).filter((g) => g.expect === 'good');
  const bad = Object.values(grades).filter((g) => g.expect === 'bad');
  for (const g of good) {
    for (const b of bad) {
      for (const goodIs of ['A', 'B']) {
        const [A, B] = goodIs === 'A' ? [g, b] : [b, g];
        const v = await judgePair({
          prompt: CONTROL_PROMPT,
          A: A.shots,
          B: B.shots,
          model,
          work: join(
            out,
            'controls',
            'judge',
            `${g.name}-vs-${b.name}-${goodIs}`,
          ),
        });
        verdicts.push({ good: g.name, bad: b.name, goodIs, ...v });
        if (v.winner !== goodIs) {
          problems.push(
            `judge picked ${v.winner === 'tie' ? 'a tie' : b.name} over ${g.name} (good shown as ${goodIs}): ${v.reason ?? v.error ?? ''}`,
          );
        }
      }
    }
  }
  return { verdicts, problems };
}

export function printControls(grades) {
  const rows = Object.values(grades).map(
    (g) =>
      `  ${g.expect === 'good' ? '+' : '-'} ${g.name.padEnd(18)} ${g.pass ? 'pass' : 'FAIL'}  ` +
      `${g.violations}/${g.rulesEvaluated} broken  ${Object.entries(g.rules)
        .filter(([, v]) => v === false)
        .map(([k]) => k)
        .join(', ')}`,
  );
  console.log(`controls:\n${rows.join('\n')}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const out = resolve(args.out ?? DEFAULT_OUT);
  mkdirSync(out, { recursive: true });
  const graded = await gradeControls({ out, repo: resolve(args.repo ?? REPO) });
  printControls(graded.grades);
  let problems = graded.problems;
  let verdicts = [];
  if (args.judge && !problems.length) {
    const judged = await judgeControls({
      grades: graded.grades,
      judgePair,
      model: args.judgeModel,
      out,
    });
    verdicts = judged.verdicts;
    problems = judged.problems;
    for (const v of verdicts)
      console.log(
        `  judge: ${v.good} vs ${v.bad} (good as ${v.goodIs}) -> ${v.winner}`,
      );
  }
  writeJSON(join(out, 'controls', 'controls.json'), {
    grades: graded.grades,
    verdicts,
    problems,
  });
  if (problems.length)
    fail(
      `controls do not rank correctly; fix the metric before trusting any result:\n  ${problems.join('\n  ')}`,
    );
  console.log(
    `controls rank correctly${args.judge ? ' (grader and judge)' : ' (grader)'}`,
  );
}

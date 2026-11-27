#!/usr/bin/env node
// Runs the matrix: every prompt × variant × run is a cell, and each cell is
// "empty project, then prompt, then app". The cell gets an app from
// `react-x11 create` with react-x11 packed from this checkout, only the
// variant's context files, an install, a headless display, and then the
// agent, unattended, with a wall clock. Each cell is graded as it finishes;
// then the judge compares the variants pairwise and the report is written.
//
//   node evals/run.mjs --variants none,create-default --prompts dev --runs 3 --agent claude
//
// See evals/README.md for every option and what a run costs.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir, platform, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { agentNamed, readStream } from './lib/agents.mjs';
import {
  createApp,
  npmInstall,
  packReactX11,
  staleCreateDefault,
  startDisplay,
} from './lib/apps.mjs';
import {
  DEFAULT_OUT,
  EVALS,
  REPO,
  childEnv,
  duration,
  fail,
  gitInfo,
  list,
  loadPrompts,
  loadVariant,
  parseArgs,
  readJSON,
  rng,
  runProcess,
  sha256,
  writeJSON,
} from './lib/common.mjs';
import { gradeControls, printControls } from './controls.mjs';
import { gradeRun, summary } from './grade.mjs';
import {
  DEFAULT_JUDGE_MODEL,
  judgeBatch,
  judgePair,
  winRates,
} from './judge.mjs';
import { judgeControls } from './controls.mjs';
import { buildReport } from './report.mjs';
import { writeFileSync } from 'node:fs';

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(
    readFileSync(join(EVALS, 'README.md'), 'utf8')
      .split('## Options')[1]
      ?.split('\n## ')[0] ?? 'see evals/README.md',
  );
  process.exit(0);
}

const variants = list(args.variants ?? 'none,create-default').map(loadVariant);
if (new Set(variants.map((v) => v.name)).size !== variants.length)
  fail('a variant is named twice');
const runs = Number(args.runs ?? 1);
const agentName = args.agent ?? 'claude';
const agent = agentNamed(agentName);
const model = args.model;
const effort = args.effort;
const timeoutMs = duration(args.timeout, 15 * 60_000);
const budgetUsd = args.budget === false ? undefined : Number(args.budget ?? 25);
const repo = resolve(args.repo ?? REPO);
const out = resolve(args.out ?? DEFAULT_OUT);
const judgeModel = args.judgeModel ?? DEFAULT_JUDGE_MODEL;
const concurrency = Number(args.concurrency ?? 1);
const permissionMode = args.permissionMode ?? 'auto';

// --limit n: the first n prompts taken round-robin across archetypes, so a
// small run still spans different kinds of app
let prompts = loadPrompts(args.prompts ?? 'dev');
if (args.limit) {
  const byType = new Map();
  for (const p of prompts)
    byType.set(p.archetype, [...(byType.get(p.archetype) ?? []), p]);
  const picked = [];
  for (let i = 0; picked.length < prompts.length; i++) {
    for (const group of byType.values()) if (group[i]) picked.push(group[i]);
  }
  prompts = picked.slice(0, Number(args.limit));
}
const suffix = readFileSync(join(EVALS, 'prompts/suffix.txt'), 'utf8').trim();

// No CLAUDE.md or AGENTS.md may sit above the runs: Claude Code would read
// it into every arm, the baseline included.
for (let d = out; ; d = dirname(d)) {
  for (const f of ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md']) {
    if (existsSync(join(d, f)))
      fail(
        `${join(d, f)} is above the runs directory and would be read by every arm. Use --out elsewhere.`,
      );
  }
  if (dirname(d) === d) break;
}
if (out.startsWith(`${REPO}/`) || out.startsWith(`${repo}/`)) {
  fail(
    `--out ${out} is inside the react-x11 checkout, where the agent would find its source and AGENTS.md. Use a directory outside it.`,
  );
}
if (existsSync(join(homedir(), '.claude/CLAUDE.md'))) {
  console.warn(
    'warning: ~/.claude/CLAUDE.md exists; Claude Code may read it into every arm.',
  );
}

const bin = agent.bin();
if (!bin) fail(`no ${agentName} binary found (set CLAUDE_BIN)`);
const agentVersion = agent.version(bin);
if (!args.dryRun) {
  const auth = agent.checkAuth(bin);
  if (!auth.ok) fail(auth.message);
}

const stamp = new Date()
  .toISOString()
  .replace(/[-:]/g, '')
  .replace(/\..*/, '')
  .replace('T', '-');
const batchId =
  args.batch ?? `${stamp}-${variants.map((v) => v.name).join('-vs-')}`;
const batchDir = join(out, 'batches', batchId);
mkdirSync(batchDir, { recursive: true });
const existing = readJSON(join(batchDir, 'batch.json'), null);

const reactX11 =
  existing?.reactX11 && existsSync(existing.reactX11.tarball)
    ? existing.reactX11
    : packReactX11(repo, join(batchDir, 'pkg'));
if (!reactX11.hasDocs) {
  console.warn(
    `warning: react-x11 ${reactX11.version} from ${repo} packs no docs/, which AGENTS.md points the agent at.`,
  );
}

const batch = {
  id: batchId,
  created: existing?.created ?? new Date().toISOString(),
  out,
  repo,
  variants: variants.map((v) => v.name),
  variantFiles: Object.fromEntries(
    variants.map((v) => [
      v.name,
      { sha256: v.sha256, files: Object.keys(v.files), env: v.env ?? {} },
    ]),
  ),
  prompts: prompts.map(({ id, set, archetype, text, checklist }) => ({
    id,
    set,
    archetype,
    text,
    checklist,
    sha256: sha256(text),
  })),
  suffix,
  runs,
  timeoutMs,
  budgetUsd: budgetUsd ?? null,
  agent: {
    name: agentName,
    bin,
    version: agentVersion,
    model: model ?? null,
    effort: effort ?? null,
    permissionMode,
  },
  judgeModel,
  reactX11,
  harness: { git: gitInfo(EVALS, ['.']) },
  node: process.version,
  platform: `${platform()} ${release()}`,
};
writeJSON(join(batchDir, 'batch.json'), batch);
console.log(`batch ${batchDir}`);
console.log(
  `  ${prompts.length} prompts × ${variants.length} variants × ${runs} runs = ${prompts.length * variants.length * runs} cells, ` +
    `${agentName} ${agentVersion ?? ''}${model ? ` (${model})` : ''}, react-x11 ${reactX11.version}`,
);

if (args.controls !== false) {
  const graded = await gradeControls({ out, repo, tarball: reactX11.tarball });
  printControls(graded.grades);
  writeJSON(join(batchDir, 'controls.json'), {
    problems: graded.problems,
    grades: graded.grades,
  });
  if (graded.problems.length) {
    fail(
      `the grader does not rank the controls correctly; fix it before trusting any result:\n  ${graded.problems.join('\n  ')}`,
    );
  }
}

// cells, in a seeded order that alternates the variants within a prompt
const random = rng(Number.parseInt(sha256(batchId).slice(0, 8), 16));
const cells = [];
for (let run = 1; run <= runs; run++) {
  for (const prompt of prompts) {
    const order = [...variants];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (const variant of order)
      cells.push({
        id: `${prompt.id}--${variant.name}--${run}`,
        prompt,
        variant,
        run,
      });
  }
}

async function runCell({ id, prompt, variant, run }) {
  const dir = join(batchDir, 'runs', id);
  if (!args.force && existsSync(join(dir, 'agent.json'))) {
    if (args.grade !== false && !existsSync(join(dir, 'grade.json')))
      console.log(summary(await gradeRun(dir)));
    return;
  }
  const app = join(dir, 'app');
  const text = `${prompt.text}\n\n${suffix}`;
  writeJSON(join(dir, 'cell.json'), {
    id,
    variant: variant.name,
    prompt: prompt.id,
    set: prompt.set,
    archetype: prompt.archetype,
    run,
    agent: agentName,
    model: model ?? null,
    promptText: text,
  });
  const created = createApp({
    repo,
    dir: app,
    tarball: reactX11.tarball,
    variant,
  });
  const stale = staleCreateDefault(created.createdWith, variant);
  if (stale.length) {
    console.warn(
      `warning: ${repo}'s react-x11 create writes a different ${stale.join(', ')} than variants/create-default; run evals/variants/sync.mjs create-default`,
    );
  }
  const install = npmInstall(app, join(dir, 'install.log'));
  writeJSON(join(dir, 'setup.json'), {
    create: created.argv,
    staleCreateDefault: stale,
    install: { ok: install.ok, ms: install.ms },
  });
  if (!install.ok) {
    writeJSON(join(dir, 'agent.json'), {
      skipped: 'install failed before the agent ran',
      install: install.tail,
    });
    console.log(`${id}: install failed before the agent ran:\n${install.tail}`);
    return;
  }
  if (args.dryRun) {
    console.log(`${id}: ready (dry run, agent not started)`);
    return;
  }

  const display = await startDisplay(app);
  const started = Date.now();
  console.log(
    `${id}: ${agentName} started ${new Date(started).toLocaleTimeString()}`,
  );
  const r = await runProcess(
    bin,
    agent.args({
      prompt: text,
      model,
      effort,
      budgetUsd,
      permissionMode,
      variant: variant.name,
    }),
    {
      cwd: app,
      env: childEnv({ DISPLAY: display.display, ...(variant.env ?? {}) }),
      timeoutMs,
      stdout: join(dir, 'transcript.jsonl'),
      stderr: join(dir, 'agent-stderr.log'),
    },
  );
  display.stop();
  const parsed = agent.parse(readStream(join(dir, 'transcript.jsonl')));
  writeJSON(join(dir, 'agent.json'), {
    exit: r.code,
    signal: r.signal,
    timedOut: r.timedOut,
    wallMs: r.ms,
    agentVersion: parsed.agentVersion ?? agentVersion,
    model: parsed.model,
    finished: parsed.finished,
    costUsd: parsed.costUsd,
    tokens: parsed.tokens,
    toolCalls: parsed.toolCalls,
    numTurns: parsed.numTurns,
    finalText: parsed.finalText,
  });
  console.log(
    `${id}: done in ${(r.ms / 60000).toFixed(1)} min${r.timedOut ? ' (TIMED OUT)' : ''}, ` +
      `${parsed.costUsd == null ? 'cost unknown' : `$${parsed.costUsd.toFixed(2)}`}, ${parsed.toolCalls} tool calls`,
  );
  if (args.grade !== false) console.log(summary(await gradeRun(dir)));
}

const queue = [...cells];
await Promise.all(
  Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (queue.length) await runCell(queue.shift());
  }),
);
if (args.dryRun) process.exit(0);

if (
  args.judge !== false &&
  variants.length > 1 &&
  args.grade !== false &&
  agentName !== 'fixture'
) {
  if (args.controls !== false) {
    const graded = readJSON(join(batchDir, 'controls.json'));
    const judged = await judgeControls({
      grades: graded.grades,
      judgePair,
      model: judgeModel,
      out: batchDir,
    });
    writeJSON(join(batchDir, 'judge', 'controls.json'), judged);
    for (const v of judged.verdicts)
      console.log(
        `  control: ${v.good} vs ${v.bad} (good as ${v.goodIs}) -> ${v.winner}`,
      );
    if (judged.problems.length) {
      fail(
        `the judge does not rank the controls correctly; its verdicts are not trusted:\n  ${judged.problems.join('\n  ')}`,
      );
    }
  }
  const comparisons = await judgeBatch(batchDir, { model: judgeModel });
  for (const [v, r] of Object.entries(winRates(comparisons))) {
    console.log(`  ${v}: ${r.wins}-${r.ties}-${r.losses}`);
  }
}

const md = buildReport(batchDir);
writeFileSync(join(batchDir, 'report.md'), `${md}\n`);
console.log(`\n${md}\n\nreport: ${join(batchDir, 'report.md')}`);

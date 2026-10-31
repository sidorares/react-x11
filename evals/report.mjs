#!/usr/bin/env node
// A batch as markdown: one row per variant with its pass rate, rules broken,
// trap hits, tokens, cost, time and pairwise win rate, each with its
// run-to-run spread (mean ± standard deviation over runs), then what is
// behind each number.
//
//   node evals/report.mjs <batch dir>     # writes <batch>/report.md and prints it
import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJSON } from './lib/common.mjs';
import { runDirsOf } from './grade.mjs';
import { winRates } from './judge.mjs';

const mean = (xs) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const sd = (xs) => {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
};
const nums = (xs) =>
  xs.filter((x) => typeof x === 'number' && Number.isFinite(x));
function spread(xs, digits = 1, unit = '') {
  const v = nums(xs);
  if (!v.length) return '—';
  const f = (x) => `${x.toFixed(digits)}${unit}`;
  const s = sd(v);
  return s === null ? f(mean(v)) : `${f(mean(v))} ± ${f(s)}`;
}
const pct = (k, n) => (n ? `${Math.round((k / n) * 100)}% (${k}/${n})` : '—');
const kTokens = (n) => n / 1000;

const RULES = {
  noHardcodedColours: 'no hard-coded colours',
  allControlsNamed: 'every control named',
  menuBar: 'MenuBar',
  minWidth: 'minWidth set',
  noWideButtons: 'no stretched buttons',
  noWebLook: 'no website look',
  followsDarkMode: 'dark mode is dark',
};
const GATES = {
  install: 'install',
  mountLight: 'mounts (light)',
  mountDark: 'mounts (dark)',
  noWebImports: 'no web imports',
};

export function buildReport(batchDir) {
  const batch = readJSON(join(batchDir, 'batch.json'));
  const grades = runDirsOf(batchDir)
    .map((d) => readJSON(join(d, 'grade.json'), null))
    .filter(Boolean);
  const comparisons = readJSON(join(batchDir, 'judge', 'comparisons.json'), []);
  const rates = winRates(comparisons);
  const controls = readJSON(join(batchDir, 'controls.json'), null);
  const judgeControls = readJSON(
    join(batchDir, 'judge', 'controls.json'),
    null,
  );
  const by = (v) => grades.filter((g) => g.variant === v);
  const L = [];

  L.push(`# react-x11 agent-context eval: ${batch.id}`, '');
  L.push(
    `- **Prompts**: ${batch.prompts.map((p) => p.id).join(', ')} (${[...new Set(batch.prompts.map((p) => p.set))].join(', ')} set), ${batch.runs} run(s) each`,
    `- **Agent**: ${batch.agent.name} ${batch.agent.version ?? '?'}, model ${[...new Set(grades.flatMap((g) => g.agent.models ?? []))].join(', ') || batch.agent.model || 'default'}` +
      `${batch.agent.effort ? `, effort ${batch.agent.effort}` : ''}, timeout ${Math.round(batch.timeoutMs / 60000)} min`,
    `- **react-x11**: ${batch.reactX11.version} from ${batch.reactX11.git ? `${batch.reactX11.git.branch}@${batch.reactX11.git.sha.slice(0, 9)}${batch.reactX11.git.dirty ? ' (uncommitted changes)' : ''}` : batch.repo}` +
      `${batch.reactX11.hasDocs ? ', docs/ in the package' : ', **no docs/ in the package**'}`,
    `- **Harness**: ${batch.harness?.git ? `${batch.harness.git.branch}@${batch.harness.git.sha.slice(0, 9)}${batch.harness.git.dirty ? ' (uncommitted changes)' : ''}` : '?'}, node ${batch.node}, ${batch.platform}`,
    `- **Judge**: ${comparisons.length ? `${[...new Set(comparisons.map((c) => c.judgeModel))].join(', ')}, ${comparisons.filter((c) => c.decidedBy === 'judge').length} judged + ${comparisons.filter((c) => c.decidedBy === 'gate').length} decided by a gate` : 'not run'}`,
    `- **Controls**: grader ${controls ? (controls.problems.length ? '**FAILED**' : 'ranks them correctly') : 'not checked'}; judge ${judgeControls ? (judgeControls.problems.length ? '**FAILED**' : `ranks them correctly (${judgeControls.verdicts.length} comparisons)`) : 'not checked'}`,
    '',
  );

  L.push('## Per variant', '');
  L.push(
    '| variant | runs | pass rate | rules broken | trap hits | win rate | output tokens (k) | all tokens (k) | cost ($) | time (min) | tool calls | timed out |',
  );
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const v of batch.variants) {
    const g = by(v);
    const r = rates[v];
    L.push(
      `| ${v} | ${g.length} | ${pct(g.filter((x) => x.pass).length, g.length)} | ${spread(g.map((x) => x.violations))} | ${spread(g.map((x) => x.traps?.total))} | ` +
        `${r?.rate == null ? '—' : `${r.rate.toFixed(2)} [${r.ci[0].toFixed(2)}–${r.ci[1].toFixed(2)}] (${r.wins}-${r.ties}-${r.losses})`} | ` +
        `${spread(
          g.map((x) => x.agent.tokens && kTokens(x.agent.tokens.output)),
          0,
        )} | ${spread(
          g.map((x) => x.agent.tokens && kTokens(x.agent.tokens.total)),
          0,
        )} | ` +
        `${spread(
          g.map((x) => x.agent.costUsd),
          2,
        )} | ${spread(g.map((x) => x.agent.wallMs && x.agent.wallMs / 60000))} | ` +
        `${spread(
          g.map((x) => x.agent.toolCalls),
          0,
        )} | ${g.filter((x) => x.agent.timedOut).length} |`,
    );
  }
  L.push(
    '',
    'Mean ± standard deviation over runs. Win rate counts a tie as half, with a 95% Wilson interval and wins-ties-losses. ' +
      'Rules broken is out of the rules that could be checked (a window that never mounted has no layout to check).',
    '',
  );

  L.push('## Gates and rules (share of runs that pass)', '');
  L.push(
    `| variant | ${[...Object.values(GATES), ...Object.values(RULES)].join(' | ')} |`,
  );
  L.push(
    `|---|${[...Object.keys(GATES), ...Object.keys(RULES)].map(() => '---').join('|')}|`,
  );
  for (const v of batch.variants) {
    const g = by(v);
    const gates = Object.keys(GATES).map((k) =>
      pct(g.filter((x) => x.gates[k]).length, g.length),
    );
    const rules = Object.keys(RULES).map((k) => {
      const seen = g.filter(
        (x) => x.rules[k] !== null && x.rules[k] !== undefined,
      );
      return pct(seen.filter((x) => x.rules[k]).length, seen.length);
    });
    L.push(`| ${v} | ${[...gates, ...rules].join(' | ')} |`);
  }
  L.push('');

  const trapIds = [
    ...new Set(grades.flatMap((g) => Object.keys(g.traps?.hits ?? {}))),
  ];
  if (trapIds.length) {
    L.push('## Trap hits by kind (total over runs)', '');
    L.push(
      `| variant | ${trapIds.join(' | ')} |`,
      `|---|${trapIds.map(() => '---').join('|')}|`,
    );
    for (const v of batch.variants) {
      L.push(
        `| ${v} | ${trapIds.map((t) => by(v).reduce((s, g) => s + (g.traps?.hits?.[t] ?? 0), 0)).join(' | ')} |`,
      );
    }
    L.push('');
  }

  if (batch.variants.length > 2 && comparisons.length) {
    L.push('## Head to head (row beats column)', '');
    L.push(
      `| | ${batch.variants.join(' | ')} |`,
      `|---|${batch.variants.map(() => '---').join('|')}|`,
    );
    for (const a of batch.variants) {
      L.push(
        `| ${a} | ${batch.variants.map((b) => (a === b ? '' : rates[a]?.vs[b] ? `${rates[a].vs[b].rate.toFixed(2)} (n=${rates[a].vs[b].n})` : '—')).join(' | ')} |`,
      );
    }
    L.push('');
  }

  L.push('## Per prompt', '');
  L.push(
    `| prompt | ${batch.variants.join(' | ')} |`,
    `|---|${batch.variants.map(() => '---').join('|')}|`,
  );
  for (const p of batch.prompts) {
    const cells = batch.variants.map((v) => {
      const g = grades
        .filter((x) => x.prompt === p.id && x.variant === v)
        .sort((a, b) => a.run - b.run);
      if (!g.length) return '—';
      const wins = comparisons.filter(
        (c) => c.prompt === p.id && c.variants.includes(v) && c.winner,
      );
      const score = wins.length
        ? ` · won ${wins.filter((c) => c.winner === v).length + wins.filter((c) => c.winner === 'tie').length / 2}/${wins.length}`
        : '';
      return `${g.map((x) => (x.pass ? `✓${x.violations}` : '✗')).join(' ')}${score}`;
    });
    L.push(`| ${p.id} (${p.archetype}) | ${cells.join(' | ')} |`);
  }
  L.push(
    '',
    '✓n: passed every gate with n rules broken; ✗: failed a gate. One mark per run.',
    '',
  );

  const failures = grades.filter((g) => !g.pass);
  if (failures.length) {
    L.push('## Gate failures', '');
    for (const g of failures) {
      const why = Object.entries(g.gates)
        .filter(([, ok]) => !ok)
        .map(([k]) => k)
        .join(', ');
      const err =
        g.details.smokeErrors?.light ??
        g.details.install ??
        g.details.webImports?.map((w) => w.text).join(', ') ??
        '';
      L.push(
        `- **${g.id}**: ${why}. ${String(err).split('\n')[0].slice(0, 240)}`,
      );
    }
    L.push('');
  }
  return L.join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2] && resolve(process.argv[2]);
  if (!dir || !existsSync(join(dir, 'batch.json'))) {
    console.error('usage: report.mjs <batch dir>');
    process.exit(1);
  }
  const md = buildReport(dir);
  writeFileSync(join(dir, 'report.md'), `${md}\n`);
  console.log(md);
  console.log(`\nwritten to ${join(dir, 'report.md')}`);
}

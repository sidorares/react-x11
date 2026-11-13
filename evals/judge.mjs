#!/usr/bin/env node
// Blind pairwise judging. For every prompt and run index, each pair of
// variants' apps goes to an LLM as "A" and "B" in a random (seeded) order:
// four pictures (light and dark of each), the request, its hidden checklist,
// and judge-rubric.md, which is DESIGN.md's "What makes it look like a
// website" and "Before calling it done" frozen, so the yardstick does not
// move while the context files are tuned. The judge sees no variant name,
// file name or code. An app that failed a hard gate loses without a call.
//
// Before any of that, the controls: the judge must pick the good control
// over each bad one in both orders, or it is not trusted with the runs.
//
//   node evals/judge.mjs <batch> [--model opus] [--seed n] [--skip-controls]
//   node evals/judge.mjs <batch> --export-human     # a page for a person to judge the same pairs
//   node evals/judge.mjs <batch> --agreement <human-verdicts.json>
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { agentNamed } from './lib/agents.mjs';
import {
  fail,
  parseArgs,
  readJSON,
  rng,
  sha256,
  writeJSON,
} from './lib/common.mjs';
import { gradeControls, judgeControls, printControls } from './controls.mjs';
import { DEFAULT_JUDGE_MODEL, judgePair } from './lib/judgepair.mjs';
import { runDirsOf } from './grade.mjs';

export { DEFAULT_JUDGE_MODEL, judgePair };

/** Every comparison a batch calls for: same prompt, same run index, each
 * pair of variants. */
export function pairsOf(batchDir) {
  const batch = readJSON(join(batchDir, 'batch.json'));
  const grades = runDirsOf(batchDir)
    .map((dir) => ({ dir, grade: readJSON(join(dir, 'grade.json'), null) }))
    .filter((g) => g.grade);
  const variants = batch.variants;
  const pairs = [];
  for (const prompt of batch.prompts) {
    for (let run = 1; run <= batch.runs; run++) {
      for (let i = 0; i < variants.length; i++) {
        for (let j = i + 1; j < variants.length; j++) {
          const a = grades.find(
            (g) =>
              g.grade.prompt === prompt.id &&
              g.grade.run === run &&
              g.grade.variant === variants[i],
          );
          const b = grades.find(
            (g) =>
              g.grade.prompt === prompt.id &&
              g.grade.run === run &&
              g.grade.variant === variants[j],
          );
          if (!a || !b) continue;
          pairs.push({
            pairId: sha256(
              `${prompt.id}|${run}|${variants[i]}|${variants[j]}`,
            ).slice(0, 12),
            prompt,
            run,
            a,
            b,
          });
        }
      }
    }
  }
  return { batch, pairs };
}

export async function judgeBatch(
  batchDir,
  { model = DEFAULT_JUDGE_MODEL, seed, force = false } = {},
) {
  const { batch, pairs } = pairsOf(batchDir);
  const file = join(batchDir, 'judge', 'comparisons.json');
  const done = new Map(
    (force ? [] : readJSON(file, [])).map((c) => [c.pairId, c]),
  );
  const random = rng(seed ?? Number.parseInt(sha256(batch.id).slice(0, 8), 16));
  const out = [];
  for (const p of pairs) {
    // the coin is flipped for every pair, resumed or not, so a resume
    // shows the same pairs in the same order
    const aFirst = random() < 0.5;
    const cached = done.get(p.pairId);
    if (cached && cached.judgeModel === model && !cached.error) {
      out.push(cached);
      continue;
    }
    const [first, second] = aFirst ? [p.a, p.b] : [p.b, p.a];
    const shownAs = { A: first.grade.variant, B: second.grade.variant };
    const base = {
      pairId: p.pairId,
      prompt: p.prompt.id,
      run: p.run,
      variants: [p.a.grade.variant, p.b.grade.variant],
      shownAs,
      judgeModel: model,
    };
    const ok = (g) => g.grade.pass && g.grade.shots.light && g.grade.shots.dark;
    if (!ok(first) || !ok(second)) {
      const winner = ok(first) ? shownAs.A : ok(second) ? shownAs.B : 'tie';
      out.push({
        ...base,
        winner,
        decidedBy: 'gate',
        reason: 'a hard gate failed',
      });
      continue;
    }
    const shots = (g) => ({
      light: join(g.dir, g.grade.shots.light),
      dark: join(g.dir, g.grade.shots.dark),
    });
    const v = await judgePair({
      prompt: p.prompt,
      A: shots(first),
      B: shots(second),
      model,
      work: join(batchDir, 'judge', 'pairs', p.pairId),
    });
    const byVariant = (x) =>
      x ? { [shownAs.A]: x.A, [shownAs.B]: x.B } : null;
    const c = {
      ...base,
      winner: v.winner === 'tie' ? 'tie' : v.winner ? shownAs[v.winner] : null,
      shownWinner: v.winner,
      decidedBy: 'judge',
      confidence: v.confidence,
      reason: v.reason,
      websiteFlaws: byVariant(v.websiteFlaws),
      checklistMet: byVariant(v.checklistMet),
      costUsd: v.costUsd,
      error: v.error,
    };
    out.push(c);
    console.log(
      `  ${p.prompt.id} #${p.run}: ${shownAs.A} (A) vs ${shownAs.B} (B) -> ${c.winner ?? `error: ${c.error}`}`,
    );
    writeJSON(file, [
      ...out,
      ...[...done.values()].filter(
        (d) => !out.some((o) => o.pairId === d.pairId),
      ),
    ]);
  }
  writeJSON(file, out);
  return out;
}

/** Wins count 1, ties ½, over every comparison a variant was in. */
export function winRates(comparisons) {
  const rows = {};
  const add = (v, key, n = 1) => {
    rows[v] ??= { wins: 0, ties: 0, losses: 0, n: 0, vs: {} };
    rows[v][key] += n;
  };
  for (const c of comparisons) {
    if (!c.winner) continue;
    const [x, y] = c.variants;
    for (const [v, other] of [
      [x, y],
      [y, x],
    ]) {
      const key =
        c.winner === 'tie' ? 'ties' : c.winner === v ? 'wins' : 'losses';
      add(v, key);
      add(v, 'n');
      rows[v].vs[other] ??= { wins: 0, ties: 0, losses: 0, n: 0 };
      rows[v].vs[other][key]++;
      rows[v].vs[other].n++;
    }
  }
  for (const r of Object.values(rows)) {
    r.rate = r.n ? (r.wins + r.ties / 2) / r.n : null;
    r.ci = wilson(r.wins + r.ties / 2, r.n);
    for (const vs of Object.values(r.vs))
      vs.rate = vs.n ? (vs.wins + vs.ties / 2) / vs.n : null;
  }
  return rows;
}

/** 95% Wilson interval for k successes in n. */
export function wilson(k, n, z = 1.96) {
  if (!n) return null;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/** A page a person judges the same blind pairs on, to calibrate the judge. */
function exportHuman(batchDir) {
  const comparisons = readJSON(
    join(batchDir, 'judge', 'comparisons.json'),
    [],
  ).filter((c) => c.decidedBy === 'judge');
  const { pairs } = pairsOf(batchDir);
  const items = comparisons.map((c) => {
    const p = pairs.find((x) => x.pairId === c.pairId);
    return {
      pairId: c.pairId,
      request: p.prompt.text,
      checklist: p.prompt.checklist,
    };
  });
  const html = `<!doctype html><meta charset="utf-8"><title>Judge the pairs</title>
<style>
body{font:14px system-ui,sans-serif;margin:24px;max-width:1500px}
.pair{border-top:1px solid #8884;padding:16px 0}.imgs{display:grid;grid-template-columns:1fr 1fr;gap:8px}
img{width:100%;border:1px solid #8884}pre{white-space:pre-wrap;color:#666}button{margin-right:8px;padding:4px 14px}
button.on{outline:3px solid #2a7}
</style>
<h1>Which app is the better desktop app for the request?</h1>
<p>Same instructions as the LLM judge: <code>evals/judge-rubric.md</code>. Pick A, B or tie for each pair,
then <button id="dl">Download verdicts</button> and run
<code>node evals/judge.mjs &lt;batch&gt; --agreement human-verdicts.json</code>.</p>
<div id="pairs"></div>
<script>
const items = ${JSON.stringify(items)};
const saved = (() => { try { return JSON.parse(localStorage.getItem('verdicts') || '{}'); } catch { return {}; } })();
const root = document.getElementById('pairs');
for (const it of items) {
  const d = document.createElement('div'); d.className = 'pair';
  d.innerHTML = '<p><b>' + it.request + '</b></p><pre>' + it.checklist + '</pre><div class="imgs">' +
    ['A-light','B-light','A-dark','B-dark'].map(k => '<figure><figcaption>' + k + '</figcaption><img src="../pairs/' + it.pairId + '/' + k + '.png"></figure>').join('') + '</div>';
  const bar = document.createElement('p');
  for (const w of ['A','B','tie']) {
    const b = document.createElement('button'); b.textContent = w; if (saved[it.pairId] === w) b.className = 'on';
    b.onclick = () => { saved[it.pairId] = w; try { localStorage.setItem('verdicts', JSON.stringify(saved)); } catch {}
      bar.querySelectorAll('button').forEach(x => x.className = x === b ? 'on' : ''); };
    bar.appendChild(b);
  }
  d.appendChild(bar); root.appendChild(d);
}
document.getElementById('dl').onclick = () => {
  const blob = new Blob([JSON.stringify(Object.entries(saved).map(([pairId, winner]) => ({ pairId, winner })), null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'human-verdicts.json'; a.click();
};
</script>`;
  const file = join(batchDir, 'judge', 'human', 'index.html');
  mkdirSync(join(batchDir, 'judge', 'human'), { recursive: true });
  writeFileSync(file, html);
  console.log(`${items.length} pairs to judge: open ${file}`);
}

/** How often the LLM judge agrees with a person on the same blind pairs. */
function agreement(batchDir, humanFile) {
  const human = new Map(
    readJSON(resolve(humanFile)).map((h) => [h.pairId, h.winner]),
  );
  const llm = readJSON(join(batchDir, 'judge', 'comparisons.json')).filter(
    (c) => c.decidedBy === 'judge' && c.shownWinner && human.has(c.pairId),
  );
  if (!llm.length) fail('no pair has both a human and an LLM verdict');
  const labels = ['A', 'B', 'tie'];
  const agree = llm.filter((c) => human.get(c.pairId) === c.shownWinner).length;
  const po = agree / llm.length;
  const pe = labels.reduce(
    (s, l) =>
      s +
      (llm.filter((c) => c.shownWinner === l).length / llm.length) *
        (llm.filter((c) => human.get(c.pairId) === l).length / llm.length),
    0,
  );
  const kappa = pe === 1 ? 1 : (po - pe) / (1 - pe);
  const out = { pairs: llm.length, agreement: po, kappa };
  writeJSON(join(batchDir, 'judge', 'agreement.json'), out);
  console.log(
    `judge vs human on ${llm.length} pairs: ${(po * 100).toFixed(0)}% agree, Cohen's kappa ${kappa.toFixed(2)}`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const batchDir = args._[0] && resolve(args._[0]);
  if (!batchDir || !existsSync(join(batchDir, 'batch.json'))) {
    console.error(
      'usage: judge.mjs <batch dir> [--model opus] [--seed n] [--skip-controls] [--force] | --export-human | --agreement <file>',
    );
    process.exit(1);
  }
  if (args.exportHuman) exportHuman(batchDir);
  else if (args.agreement) agreement(batchDir, args.agreement);
  else {
    const model = args.model ?? DEFAULT_JUDGE_MODEL;
    const auth = agentNamed('claude').checkAuth(agentNamed('claude').bin());
    if (!auth.ok) fail(auth.message);
    if (!args.skipControls) {
      const batch = readJSON(join(batchDir, 'batch.json'));
      const graded = await gradeControls({
        out: batch.out,
        repo: batch.repo,
        tarball: batch.reactX11.tarball,
      });
      printControls(graded.grades);
      if (graded.problems.length)
        fail(`grader controls fail:\n  ${graded.problems.join('\n  ')}`);
      const judged = await judgeControls({
        grades: graded.grades,
        judgePair,
        model,
        out: batchDir,
      });
      writeJSON(join(batchDir, 'judge', 'controls.json'), judged);
      if (judged.problems.length)
        fail(
          `the judge does not rank the controls correctly; its verdicts are not trusted:\n  ${judged.problems.join('\n  ')}`,
        );
      console.log(
        `judge ranks the controls correctly (${judged.verdicts.length} comparisons)`,
      );
    }
    const comparisons = await judgeBatch(batchDir, {
      model,
      seed: args.seed && Number(args.seed),
      force: args.force,
    });
    const rates = winRates(comparisons);
    for (const [v, r] of Object.entries(rates)) {
      console.log(
        `  ${v}: ${r.wins}-${r.ties}-${r.losses} (win rate ${r.rate === null ? '—' : r.rate.toFixed(2)})`,
      );
    }
  }
}

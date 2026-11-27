// One blind comparison: four pictures, the request and its checklist, and
// judge-rubric.md go to the model as a single message; a JSON verdict comes
// back. Apart from judge.mjs so controls.mjs can use it without importing
// judge.mjs, which imports controls.mjs.
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentNamed, readStream } from './agents.mjs';
import { EVALS, childEnv, runProcess, writeJSON } from './common.mjs';

export const DEFAULT_JUDGE_MODEL = 'opus';

const SCHEMA = {
  type: 'object',
  properties: {
    winner: { type: 'string', enum: ['A', 'B', 'tie'] },
    confidence: { type: 'integer', minimum: 1, maximum: 5 },
    reason: { type: 'string' },
    website_flaws: {
      type: 'object',
      properties: {
        A: { type: 'array', items: { type: 'string' } },
        B: { type: 'array', items: { type: 'string' } },
      },
    },
    checklist_met: {
      type: 'object',
      properties: { A: { type: 'integer' }, B: { type: 'integer' } },
    },
  },
  required: [
    'winner',
    'confidence',
    'reason',
    'website_flaws',
    'checklist_met',
  ],
};

const png = (file) => ({
  type: 'image',
  source: {
    type: 'base64',
    media_type: 'image/png',
    data: readFileSync(file).toString('base64'),
  },
});

/** The first JSON object in a string, for a model that wrapped its answer. */
function firstObject(text) {
  const start = text.indexOf('{');
  for (
    let end = text.lastIndexOf('}');
    start >= 0 && end > start;
    end = text.lastIndexOf('}', end - 1)
  ) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      // not an object yet: try ending at an earlier brace
    }
  }
  return null;
}

/**
 * One blind comparison. `A` and `B` are { light, dark } PNG paths; the
 * images are copied into `work` as A-light.png … so the record (and a
 * person checking the judge) sees exactly what the model saw.
 */
export async function judgePair({
  prompt,
  A,
  B,
  model = DEFAULT_JUDGE_MODEL,
  work,
  agent = 'claude',
}) {
  mkdirSync(work, { recursive: true });
  const shown = {};
  for (const [side, shots] of [
    ['A', A],
    ['B', B],
  ]) {
    for (const scheme of ['light', 'dark']) {
      const to = join(work, `${side}-${scheme}.png`);
      copyFileSync(shots[scheme], to);
      shown[`${side}-${scheme}`] = to;
    }
  }
  const rubric = readFileSync(join(EVALS, 'judge-rubric.md'), 'utf8');
  const content = [
    {
      type: 'text',
      text: `${rubric}\n## The request\n\n${prompt.text}\n\n## Its checklist\n\n${prompt.checklist}\n\n## The pictures\n`,
    },
  ];
  for (const key of ['A-light', 'A-dark', 'B-light', 'B-dark']) {
    content.push({ type: 'text', text: `App ${key.replace('-', ', ')}:` });
    content.push(png(shown[key]));
  }
  content.push({
    type: 'text',
    text: `Answer with one JSON object matching this schema, and nothing else:\n${JSON.stringify(SCHEMA)}`,
  });
  const input = `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`;
  const impl = agentNamed(agent);
  const bin = impl.bin();
  const r = await runProcess(
    bin,
    [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--tools',
      '',
      '--no-session-persistence',
      '--setting-sources',
      'project,local',
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--permission-prompts',
      'none',
      '--json-schema',
      JSON.stringify(SCHEMA),
      ...(model ? ['--model', model] : []),
    ],
    {
      cwd: work,
      env: childEnv(),
      timeoutMs: 5 * 60_000,
      input,
      stdout: join(work, 'judge.jsonl'),
    },
  );
  const events = readStream(join(work, 'judge.jsonl'));
  const result = [...events].reverse().find((e) => e.type === 'result');
  const parsed = impl.parse(events);
  const answer =
    result?.structured_output ??
    (typeof result?.result === 'string' ? firstObject(result.result) : null);
  const verdict = {
    winner: ['A', 'B', 'tie'].includes(answer?.winner) ? answer.winner : null,
    confidence: answer?.confidence ?? null,
    reason: answer?.reason ?? null,
    websiteFlaws: answer?.website_flaws ?? null,
    checklistMet: answer?.checklist_met ?? null,
    model: parsed.model,
    costUsd: parsed.costUsd,
    error: answer
      ? undefined
      : `no verdict (exit ${r.code}${r.timedOut ? ', timed out' : ''}): ${result?.result ?? r.stderr?.slice(-500) ?? ''}`,
  };
  writeJSON(join(work, 'verdict.json'), verdict);
  return verdict;
}

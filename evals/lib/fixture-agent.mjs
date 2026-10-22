// `--agent fixture`: a stand-in agent for working on the harness itself. It
// calls no model and costs nothing: it copies a control's App.jsx into the
// app (bad-hex for the `none` arm, good-finder for any other) and prints a
// transcript shaped like Claude Code's stream-json, with one react-x11 error
// in a command's output so the trap scan has something to find.
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { EVALS } from './common.mjs';

const variant = process.argv[2];
const control = variant === 'none' ? 'bad-hex' : 'good-finder';
copyFileSync(
  join(EVALS, 'controls', control, 'App.jsx'),
  join(process.cwd(), 'src/App.jsx'),
);

const line = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
line({
  type: 'system',
  subtype: 'init',
  model: 'fixture',
  claude_code_version: 'fixture',
  permissionMode: 'auto',
});
line({
  type: 'assistant',
  message: {
    id: 'm1',
    content: [
      {
        type: 'tool_use',
        id: 't1',
        name: 'Bash',
        input: { command: 'npm start' },
      },
    ],
    usage: { input_tokens: 10, output_tokens: 5 },
  },
});
line({
  type: 'user',
  message: {
    content: [
      {
        type: 'tool_result',
        tool_use_id: 't1',
        is_error: true,
        content:
          'Error: react-x11: raw text "hi" must be inside a <text> — wrap it',
      },
    ],
  },
});
line({
  type: 'result',
  subtype: 'success',
  is_error: false,
  total_cost_usd: 0,
  num_turns: 1,
  duration_ms: 1,
  modelUsage: {
    fixture: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
  },
  result: `copied ${control}`,
});

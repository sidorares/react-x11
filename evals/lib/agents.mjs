// The coding agents a cell can run, each as: how to start it headless, what
// version it is, and how to read its transcript into the numbers the report
// compares. Only Claude Code so far; another agent is another entry here.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EVALS, childEnv, findClaude, sh } from './common.mjs';

export const AGENTS = {
  claude: {
    bin: () => findClaude(),
    version(bin) {
      const r = sh(bin, ['--version']);
      return r.status === 0 ? r.stdout.trim() : null;
    },
    /** Fails early, before any app is made, when the CLI cannot sign in. */
    checkAuth(bin) {
      const r = sh(bin, ['auth', 'status'], { env: childEnv() });
      try {
        const status = JSON.parse(r.stdout);
        if (status.loggedIn) return { ok: true, method: status.authMethod };
      } catch {
        // an older CLI prints text, not JSON: fall through to the env check
      }
      if (process.env.ANTHROPIC_API_KEY) return { ok: true, method: 'api key' };
      return {
        ok: false,
        message:
          `${bin} is not signed in from this shell. Run \`${bin} auth login\` ` +
          '(or set CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`, or ' +
          'ANTHROPIC_API_KEY) and run again.',
      };
    },
    /**
     * Headless, auto permission mode, nothing from the user's own setup
     * (settings, MCP servers, skills) so every arm sees the same agent, and
     * the project's CLAUDE.md is the only context that differs.
     */
    args({ prompt, model, effort, budgetUsd, permissionMode = 'auto' }) {
      return [
        '-p',
        prompt,
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
        permissionMode,
        // anything auto mode would stop to ask about is refused, not hung on
        '--permission-prompts',
        'none',
        '--no-session-persistence',
        '--setting-sources',
        'project,local',
        '--strict-mcp-config',
        '--disable-slash-commands',
        ...(model ? ['--model', model] : []),
        ...(effort ? ['--effort', effort] : []),
        ...(budgetUsd ? ['--max-budget-usd', String(budgetUsd)] : []),
      ];
    },
    parse: parseClaudeStream,
  },
  // no model: for working on the harness (see fixture-agent.mjs)
  fixture: {
    bin: () => process.execPath,
    version: () => 'fixture',
    checkAuth: () => ({ ok: true }),
    args: ({ variant }) => [join(EVALS, 'lib/fixture-agent.mjs'), variant],
    parse: parseClaudeStream,
  },
};

export function agentNamed(name) {
  const agent = AGENTS[name];
  if (!agent)
    throw new Error(
      `no agent ${name} (have: ${Object.keys(AGENTS).join(', ')})`,
    );
  return agent;
}

/** One JSON object per line; a line cut off by a kill is skipped. */
export function readStream(file) {
  const out = [];
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // the last line of a killed run is cut off
    }
  }
  return out;
}

/**
 * Claude Code's stream-json: a `system` init line, `assistant` lines with
 * tool_use blocks and per-call usage, `user` lines with tool_result blocks,
 * and a final `result` line with the session's cost and token totals. A run
 * the harness killed has no `result`, so its tokens are summed from the
 * assistant lines and its cost is unknown.
 */
export function parseClaudeStream(events) {
  const init = events.find((e) => e.type === 'system' && e.subtype === 'init');
  const result = [...events].reverse().find((e) => e.type === 'result');
  const tools = new Map(); // tool_use id -> name
  const byName = {};
  const usageByMessage = new Map();
  for (const e of events) {
    if (e.type !== 'assistant' || !e.message) continue;
    for (const block of e.message.content ?? []) {
      if (block.type === 'tool_use' && !tools.has(block.id)) {
        tools.set(block.id, block.name);
        byName[block.name] = (byName[block.name] ?? 0) + 1;
      }
    }
    if (e.message.id && e.message.usage)
      usageByMessage.set(e.message.id, e.message.usage);
  }
  const sumUsage = (rows) =>
    rows.reduce(
      (acc, u) => ({
        input: acc.input + (u.input_tokens ?? u.inputTokens ?? 0),
        output: acc.output + (u.output_tokens ?? u.outputTokens ?? 0),
        cacheRead:
          acc.cacheRead +
          (u.cache_read_input_tokens ?? u.cacheReadInputTokens ?? 0),
        cacheWrite:
          acc.cacheWrite +
          (u.cache_creation_input_tokens ?? u.cacheCreationInputTokens ?? 0),
      }),
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    );
  // modelUsage covers subagents and every model the session used; the
  // per-message sum is the fallback for a run that never reached `result`
  const modelUsage = result?.modelUsage
    ? Object.values(result.modelUsage)
    : null;
  const tokens = modelUsage?.length
    ? sumUsage(modelUsage)
    : sumUsage([...usageByMessage.values()]);
  tokens.total =
    tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
  return {
    agentVersion: init?.claude_code_version ?? null,
    model: init?.model ?? null,
    models: result?.modelUsage
      ? Object.keys(result.modelUsage)
      : init?.model
        ? [init.model]
        : [],
    permissionMode: init?.permissionMode ?? null,
    finished: Boolean(result),
    resultSubtype: result?.subtype ?? null,
    isError: result?.is_error ?? null,
    terminalReason: result?.terminal_reason ?? null,
    finalText:
      typeof result?.result === 'string' ? result.result.slice(0, 2000) : null,
    costUsd: result?.total_cost_usd ?? null,
    numTurns: result?.num_turns ?? null,
    durationMs: result?.duration_ms ?? null,
    apiDurationMs: result?.duration_api_ms ?? null,
    permissionDenials: result?.permission_denials?.length ?? null,
    tokens,
    toolCalls: tools.size,
    toolsByName: byName,
    toolNameById: Object.fromEntries(tools),
  };
}

/** The text of every tool result, with the name of the tool that made it. */
export function toolResults(events) {
  const names = {};
  for (const e of events) {
    if (e.type !== 'assistant') continue;
    for (const b of e.message?.content ?? [])
      if (b.type === 'tool_use') names[b.id] = b.name;
  }
  const out = [];
  for (const e of events) {
    if (e.type !== 'user') continue;
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b.type !== 'tool_result') continue;
      const text = Array.isArray(b.content)
        ? b.content
            .map((c) => (typeof c === 'string' ? c : (c.text ?? '')))
            .join('\n')
        : String(b.content ?? '');
      out.push({
        tool: names[b.tool_use_id] ?? null,
        isError: Boolean(b.is_error),
        text,
      });
    }
  }
  return out;
}

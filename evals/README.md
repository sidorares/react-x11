# Agent-context evals

Which `AGENTS.md` and `DESIGN.md` give a coding agent the best shot at a good
react-x11 app? This directory answers that by measurement: an empty project
from `react-x11 create`, one of a fixed set of prompts, an agent left alone
with it, and then a grader, a blind judge and a report. It is not part of the
npm package (`files` in package.json lists what ships, and `evals/` is not in
it).

```bash
# the smoke run: 2 prompts × 2 variants × 1 run
node evals/run.mjs --variants none,create-default --prompts dev --runs 1 --limit 2
```

## Before the first run

- **Node 22.15 or newer**, npm, and network for `npm install` (the npm cache
  makes repeat installs fast).
- **Claude Code, signed in for headless use.** `run.mjs` finds `claude` on
  `PATH`, or the one the desktop app ships under
  `~/.config/Claude/claude-code/`, or `$CLAUDE_BIN`. A session started from
  the desktop app is signed in through the app, which a child process is
  not: run `claude auth login` once in a terminal (or export
  `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, or
  `ANTHROPIC_API_KEY`). `run.mjs` and `judge.mjs` check this before they
  build anything.
- Linux or macOS. The pictures are always the X11 headless render, on both.

## What a cell is

A cell is one prompt × one variant × one run. For each, `run.mjs`:

1. packs react-x11 from the checkout under test (`--repo`, default the one
   this directory is in) with `npm pack`, once per batch, so the app installs
   exactly that react-x11, `docs/` included, and the version is recorded;
2. runs that checkout's `react-x11 create <batch>/runs/<cell>/app` and keeps
   only the variant's context files: whatever create wrote of `AGENTS.md`,
   `CLAUDE.md` and `DESIGN.md` is removed, the variant's are copied in, and
   a README paragraph pointing at a file the arm does not have is dropped;
3. points `react-x11` at the packed tarball and runs `npm install`;
4. starts a headless X display (node-x11's JavaScript X server on the
   loopback, [lib/xdisplay.mjs](lib/xdisplay.mjs)), so the agent's
   `npm start` runs the way it would on a desktop and opens nothing on yours;
5. runs the agent headless in the app directory with the prompt plus
   [prompts/suffix.txt](prompts/suffix.txt), with a wall clock (15 minutes by
   default) that kills the agent and everything it started;
6. grades the result (below).

The agent is Claude Code with `-p --output-format stream-json --verbose
--permission-mode auto --permission-prompts none` (whatever auto mode would
ask about is refused rather than hung on), and with nothing of the person's
own setup: `--setting-sources project,local --strict-mcp-config
--disable-slash-commands --no-session-persistence`. The environment is the
harness's minus the desktop session's `CLAUDE*` variables and the real
`DISPLAY`/`WAYLAND_DISPLAY`. The project's `CLAUDE.md`, when the variant has
one, is the only context that differs between arms.

**Runs live outside the repository**, in `~/.cache/react-x11-evals/` (or
`--out`, or `$REACT_X11_EVALS_OUT`). Claude Code reads every `CLAUDE.md` from
its working directory up to `/`, and an agent that can see react-x11's own
source, examples and `AGENTS.md` is not measuring the arm it was given.
`run.mjs` refuses an `--out` inside the checkout or under any `CLAUDE.md` or
`AGENTS.md`.

## Options

`node evals/run.mjs [options]`

| option                                      | default                    |                                                                   |
| ------------------------------------------- | -------------------------- | ----------------------------------------------------------------- |
| `--variants a,b,…`                          | `none,create-default`      | directories under `variants/`                                     |
| `--prompts dev`                             | `dev`                      | a set (`dev`, `test`), prompt ids, or archetypes, comma-separated |
| `--limit n`                                 | all                        | the first n prompts, taken round-robin across archetypes          |
| `--runs n`                                  | 1                          | runs per prompt × variant                                         |
| `--agent claude`                            | `claude`                   | `fixture` runs no model (see below)                               |
| `--model m`, `--effort e`                   | the CLI's default          | passed to the agent                                               |
| `--permission-mode m`                       | `auto`                     | `bypassPermissions` if auto mode is unavailable                   |
| `--timeout 15m`                             | 15m                        | wall clock per cell                                               |
| `--budget usd`                              | 25                         | `--max-budget-usd` per cell; `--no-budget` lifts it               |
| `--concurrency n`                           | 1                          | cells at once; each needs a CPU and some RAM                      |
| `--repo dir`                                | this checkout              | the react-x11 checkout to pack and run `create` from              |
| `--out dir`                                 | `~/.cache/react-x11-evals` | where batches go                                                  |
| `--batch name`                              | timestamp and variants     | rerunning a batch name resumes it: finished cells are skipped     |
| `--force`                                   |                            | rerun cells that already ran                                      |
| `--judge-model m`                           | `opus`                     | the judge's model                                                 |
| `--no-grade`, `--no-judge`, `--no-controls` |                            | skip a stage                                                      |
| `--dry-run`                                 |                            | build and install every cell, start no agent                      |

The stages also run on their own, over a batch directory:

```bash
node evals/grade.mjs <batch> [--force]          # grade cells that have no grade.json
node evals/judge.mjs <batch> [--model opus]      # controls, then every pair
node evals/report.mjs <batch>                    # writes <batch>/report.md
node evals/controls.mjs [--judge]                # the self-check alone
```

## What is measured

### Hard gates (a run passes only if all hold)

| gate                          | meaning                                                                                                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| install                       | a clean `npm install` of the app's `package.json`, in the grader's own copy without the agent's `node_modules`, succeeds                                                                               |
| mounts (light), mounts (dark) | the grader's smoke test, which no agent sees ([lib/smoke.mjs](lib/smoke.mjs)), mounts `src/App.jsx`'s default (or named `App`) export with `react-x11/test`, headless, in each scheme, without a throw |
| no web imports                | nothing in the source or `package.json` is react-dom, Tailwind, MUI, Radix, Chakra, styled-components, Emotion, recharts, framer-motion, lucide-react, Electron or the like                            |

### Rules (what AGENTS.md and DESIGN.md ask for)

"Rules broken" counts the ones below that fail, out of those that could be
checked (a window that never mounted has no layout).

| rule                  | how it is checked                                                                                                                                                                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| no hard-coded colours | no string in `src/` or the entry file (comments and tests excluded) that is a hex colour, has one where CSS puts one (`1px solid #ccc`, `gradient(…, #fff)`), or has `rgb()`/`hsl()`; no named colour on a colour property. Prose like "PR #482" does not count |
| every control named   | `renderX11(…, { a11y: true }).at.focusables()` has no control without an accessible name. Focusable containers (`ContextMenu`'s wrapper is one) are listed apart and not counted                                                                                |
| MenuBar               | `<MenuBar` in the source, or a `menubar` role in the mounted tree                                                                                                                                                                                               |
| minWidth set          | the mounted `<window>` has a `minWidth`                                                                                                                                                                                                                         |
| no stretched buttons  | no `Button` at least 160 px wide and 80% of the column it sits in (the column-stretch trap). A row the app gives `role="button"` (a sidebar item) is meant to span its column and is not counted                                                                |
| no website look       | no gradient, emoji in strings or JSX text, `className`, title-sized words (26 px or more) in the top third of the window, or three or more rounded, shadowed boxes                                                                                              |
| dark mode is dark     | the dark picture's mean luminance is at least 40 below the light one's                                                                                                                                                                                          |

### Trap hits

Each time a command the agent ran printed one of react-x11's own errors for
a rule AGENTS.md states: `<x> must be inside a <window>`, `<x y=…> is a style
property`, `raw text … must be inside a <text>`, `unknown element type`,
`not allowed inside <text>`, a layout property in a state block, an unknown
or invalid style, `localStorage is not defined`. Only command output counts,
so an agent reading the docs, which quote these errors, is not a hit. Fewer
hits means the context got the rule across before the agent tripped on it.

### Process

Wall time, tokens (input, output, cache read and write, from the agent's own
accounting), cost in US dollars as Claude Code reports it (`total_cost_usd`;
with a subscription this is the API-equivalent price, not a bill), tool
calls, turns, and whether the wall clock ran out. A run the harness killed
has no cost line; its tokens are summed from what it streamed.

### Pairwise win rate

`judge.mjs` compares, for every prompt and run index, each pair of
variants' apps. The judge gets four pictures labelled A and B, light and
dark, in a seeded random order, plus the request, its hidden checklist and
[judge-rubric.md](judge-rubric.md): DESIGN.md's "What makes it look like a
website" and "Before calling it done", frozen so the yardstick stays put while
the context files are tuned. It sees no variant name, path or code, and
answers with a winner, a confidence, the website flaws it saw in each, and
how many checklist items each visibly meets. An app that failed a gate loses
without a call (both failing is a tie). Win rate is (wins + ½ ties) / pairs,
with a 95% Wilson interval.

### Spread

Every per-run number in the report is the mean ± standard deviation over
runs, so `--runs 3` or more is what makes a difference between variants
readable. The per-prompt table shows each run's result side by side.

## The controls: the harness checking itself

[controls/](controls/) holds the same file browser built five ways: well
(`good-finder`, adapted from `examples/finder.jsx`), and badly in one way
each: hard-coded colours (`bad-hex`), card soup (`bad-cards`), stretched
buttons (`bad-wide-buttons`), a hero header over a centred column
(`bad-hero`). Before a batch, the grader must pass the good one with no rule
broken, rank it above every bad one, and catch each bad one with the rule
its `control.json` names. Before judging, the judge must pick the good one
over each bad one with the pair shown in both orders. If either fails,
`run.mjs` and `judge.mjs` stop with an error rather than report numbers from
a broken metric. The grader's check costs nothing and takes seconds; the
judge's is eight comparisons.

## Variants

| variant          | what the arm gets                                                                                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `none`           | no `AGENTS.md`, `CLAUDE.md` or `DESIGN.md`                                                                                                                                                                                |
| `create-default` | exactly what `react-x11 create` writes: `AGENTS.md`, `CLAUDE.md` (`@AGENTS.md`), `DESIGN.md`, rendered from `src/cli/templates/`                                                                                          |
| `oneshot-mac`    | the Melbourne talk's oneshot `AGENTS.md` and Mac `DESIGN.md`, with their `app/` paths adapted to starting inside an existing app, the talk's `demo/` pointers removed, and `ONESHOT_NO_WINDOWS=1` set as the talk runs it |

A variant is a directory with a `variant.json` (`description`, `files`, and
optionally `env` for the agent) and the files it lists. To try a new
`AGENTS.md`, copy a variant directory, edit, and run it against the old one.
`create-default` and `oneshot-mac` are copies; regenerate them rather than
edit them:

```bash
node evals/variants/sync.mjs create-default [--repo <react-x11 checkout>]
node evals/variants/sync.mjs oneshot-mac --from <deck>/oneshot
```

`run.mjs` warns when the checkout's `create` writes something other than
`variants/create-default`.

## Prompts, and not overfitting them

[prompts/index.json](prompts/index.json) lists 12 dev prompts and 8 held-out
test prompts across five archetypes: a utility, sidebar and content, three
panes, a data-heavy table or chart, an editor. Each prompt's text is in
`prompts/<set>/<id>.txt`; its acceptance checklist, written before any run,
is in `prompts/checklists/<id>.md`, which only the judge reads.

Tune the context files on `--prompts dev`. Run `--prompts test` once, for
the variants you are deciding between, and report that number: a test score
that is looked at while tuning stops being one.

## Calibrating the judge against people

```bash
node evals/judge.mjs <batch> --export-human     # writes <batch>/judge/human/index.html
node evals/judge.mjs <batch> --agreement human-verdicts.json
```

The page shows a person the same blind pairs the judge saw, with the same
instructions; its "Download verdicts" button saves `human-verdicts.json`.
`--agreement` reports how often the judge agreed and Cohen's kappa. A kappa
under about 0.6 means the judge's win rates should not decide anything yet:
change the rubric or the judge model and measure again.

## The stand-in agent

`--agent fixture` calls no model: it copies a control's `App.jsx` into the
app (`bad-hex` for `none`, `good-finder` otherwise) and prints a transcript
in Claude Code's format with one trap in it. It runs a whole batch through
create, install, grading and the report in about half a minute, for work on
the harness itself. It skips the judge.

## On disk

```
~/.cache/react-x11-evals/
  controls/                  the controls' apps, grades and pictures; base/ is their shared install
  batches/<batch>/
    batch.json               everything a result depends on: variants and their hashes, prompts,
                             agent and version, model, react-x11 version, commit and tarball hash,
                             harness commit, node, OS
    pkg/react-x11-*.tgz      the react-x11 under test
    controls.json            the grader's control check
    runs/<prompt>--<variant>--<run>/
      cell.json              the cell, with the exact prompt
      app/                   what the agent left
      transcript.jsonl       the agent's stream-json, every tool call and result
      agent.json             exit, wall time, cost, tokens, tool calls
      shots/light.png, dark.png, smoke-*.json   the grader's pictures and raw smoke results
      grade.json             gates, rules, traps, metrics, and the details behind each
    judge/
      controls.json          the judge's control check
      pairs/<id>/            the four pictures one comparison showed, and its verdict
      comparisons.json       every comparison, unblinded
      human/index.html       from --export-human
    report.md
```

## Cost and time

Measured on the smoke run (`--limit 2`: `pomodoro` and `recipes`, `none`
and `create-default`, one run each), on 2026-10-22 with Claude Code 2.1.304,
its default model (Opus 5.5) at its default effort, react-x11 2.51.1:

| per                   | cost                    | time        | other                                                      |
| --------------------- | ----------------------- | ----------- | ---------------------------------------------------------- |
| agent run             | $0.73–$1.22, mean $0.93 | 2.1–4.0 min | 0.8–1.4 M tokens, almost all cache reads; 16–25 tool calls |
| grading a run         | nothing (local)         | about 10 s  | a clean install and two headless mounts                    |
| judged pair           | about $0.07             | about 10 s  | Opus 5.5, four pictures in one message                     |
| judge's control check | about $0.50             | about 1 min | eight pairs, once per `judge.mjs` or `run.mjs`             |
| disk                  |                         |             | about 60 MB per cell, mostly `node_modules`                |

The smoke run itself cost $4.33: $3.70 for the four agent runs, $0.49 for
the judge's control check, $0.14 for two judged pairs. Nothing came near the
15-minute clock, but these two are among the smaller prompts: three-pane,
data and editor apps should take longer and cost more, so budget about $1.50
a cell until a batch says otherwise. Cost is Claude Code's own
`total_cost_usd`; on a subscription it is the API-equivalent price, not a
bill, and counts against the plan's usage instead.

**The full dev matrix** is three variants, 12 prompts and three runs:

```bash
node evals/run.mjs --variants none,create-default,oneshot-mac --prompts dev --runs 3 --concurrency 3
```

That is 108 agent runs, about $100–160, and 108 judged pairs, about $8.
Allow 2–3 hours at `--concurrency 3`, or 6–8 hours one at a time, and about
7 GB of disk. The held-out check for the two finalists (`--prompts test
--runs 3`, 48 runs) is about $45–75 more.

## Known limits

- The pictures are the X11 headless render on every platform: no native
  bezels, the menu bar drawn in the window, platform icons missing. The
  judge is told so. What a Mac user sees is better than what is judged.
- Only the first screen is pictured and judged. Behaviour (a shortcut, a
  dialog) counts only through the rules and the checklist items visible in
  it.
- A colour in sample data (a tag's colour, `'#e5534b'`) counts as a
  hard-coded colour too. The details in `grade.json` list each one.
- The website-look rule only sees shadowed cards; bordered ones without a
  shadow get past it, and are left to the judge.
- `oneshot-mac` was written for an empty folder and a Mac; the adaptation
  keeps its content and changes only its paths.

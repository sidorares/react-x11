#!/usr/bin/env node
// Regenerates the variants that are copies of something else, so a variant
// never drifts from what it claims to be:
//
//   node evals/variants/sync.mjs create-default [--repo <react-x11 checkout>]
//   node evals/variants/sync.mjs oneshot-mac --from <deck>/oneshot
//
// create-default is exactly what `react-x11 create` writes beside the code
// (AGENTS.md, CLAUDE.md, DESIGN.md), rendered by that checkout's own
// src/cli/create.js from src/cli/templates/*.template.md.
//
// oneshot-mac is the talk's oneshot/AGENTS.md and DESIGN.md with the few
// edits the harness needs: oneshot starts in an empty folder and builds in
// ./app/, while every arm here starts inside an app `react-x11 create`
// already made. The edits are listed below, and each must match, so a
// changed source fails here rather than producing a half-edited copy.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EVALS, REPO, parseArgs, gitInfo } from '../lib/common.mjs';

const sha = (text) => createHash('sha256').update(text).digest('hex');

async function createDefault({ repo = REPO }) {
  const root = resolve(repo);
  const { appFiles } = await import(
    pathToFileURL(join(root, 'src/cli/create.js')).href
  );
  const files = appFiles({ name: 'app', title: 'app', manager: 'npm' });
  const wanted = ['AGENTS.md', 'CLAUDE.md', 'DESIGN.md'];
  const missing = wanted.filter((f) => !(f in files));
  if (missing.length) {
    throw new Error(
      `${root}: its react-x11 create writes no ${missing.join(', ')}. Point ` +
        '--repo at a checkout that has src/cli/templates/ (the ' +
        'feat/create-agents-md work).',
    );
  }
  const dir = join(EVALS, 'variants/create-default');
  for (const f of wanted) writeFileSync(join(dir, f), files[f]);
  const { version } = JSON.parse(
    readFileSync(join(root, 'package.json'), 'utf8'),
  );
  writeFileSync(
    join(dir, 'variant.json'),
    `${JSON.stringify(
      {
        description:
          'Exactly the AGENTS.md, CLAUDE.md and DESIGN.md that `react-x11 create` writes.',
        files: wanted,
        source: {
          kind: 'react-x11 create',
          version,
          git: gitInfo(root, ['src/cli/templates', 'src/cli/create.js']),
          sha256: Object.fromEntries(wanted.map((f) => [f, sha(files[f])])),
        },
      },
      null,
      2,
    )}\n`,
  );
  console.log(`create-default: rendered by react-x11 ${version} at ${root}`);
}

// [what the source says, what the eval copy says instead, why]
const ONESHOT_EDITS = [
  [
    '- **Build in `./app/`** (create it). Write only inside the folder you were started in (your own\n  `oneshot/runs/N-idea/`).',
    '- **Build in this folder**: it is the app, already made with `react-x11 create`.\n  Write only inside it.',
    'the app exists already',
  ],
  ['`app/NOTES.md`', '`NOTES.md`', 'paths are relative to the app'],
  ['`cd app && npm start`', '`npm start`', 'the agent is in the app'],
  ['`app/README.md`', '`README.md`', 'paths are relative to the app'],
  ['```bash\nmkdir -p app && cd app\n```\n\n', '', 'the app exists already'],
  ['`app/package.json`:', '`package.json`:', 'paths are relative to the app'],
  ['`app/app.jsx`', '`app.jsx`', 'paths are relative to the app'],
  ['after `npm install` in `app/`', 'after `npm install`', 'ditto'],
  ['`app/node_modules/', '`node_modules/', 'ditto'],
  ['`app/test/app.test.jsx`', '`test/app.test.jsx`', 'ditto'],
  [
    /- \*\*In this repository\*\* \(the talk's own code[\s\S]*?tiny starters\.\n/,
    '',
    "the talk's demo/ and examples/ are not next to an eval run",
  ],
];

function oneshotMac({ from }) {
  if (!from) throw new Error('oneshot-mac: pass --from <deck>/oneshot');
  const src = resolve(from);
  let agents = readFileSync(join(src, 'AGENTS.md'), 'utf8');
  const design = readFileSync(join(src, 'DESIGN.md'), 'utf8');
  for (const [was, now, why] of ONESHOT_EDITS) {
    const hit =
      typeof was === 'string' ? agents.includes(was) : was.test(agents);
    if (!hit) {
      throw new Error(
        `oneshot-mac: ${src}/AGENTS.md no longer contains ${String(was).slice(0, 60)}… (${why}). Update ONESHOT_EDITS.`,
      );
    }
    agents =
      typeof was === 'string'
        ? agents.split(was).join(now)
        : agents.replace(was, now);
  }
  const dir = join(EVALS, 'variants/oneshot-mac');
  writeFileSync(join(dir, 'AGENTS.md'), agents);
  writeFileSync(join(dir, 'DESIGN.md'), design);
  // oneshot links AGENTS.md in as CLAUDE.md; an import is the same to Claude
  // Code and survives being copied
  writeFileSync(join(dir, 'CLAUDE.md'), '@AGENTS.md\n');
  writeFileSync(
    join(dir, 'variant.json'),
    `${JSON.stringify(
      {
        description:
          "The Melbourne talk's oneshot AGENTS.md and Mac DESIGN.md, paths adapted to start inside the app.",
        files: ['AGENTS.md', 'CLAUDE.md', 'DESIGN.md'],
        // its AGENTS.md skips the native-window steps when this is set,
        // which is what the talk runs with
        env: { ONESHOT_NO_WINDOWS: '1' },
        source: {
          kind: 'oneshot',
          git: gitInfo(src, ['AGENTS.md', 'DESIGN.md']),
          sha256: {
            'AGENTS.md': sha(readFileSync(join(src, 'AGENTS.md'), 'utf8')),
            'DESIGN.md': sha(design),
          },
          edits: ONESHOT_EDITS.map(([, , why]) => why),
        },
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    `oneshot-mac: copied from ${src} with ${ONESHOT_EDITS.length} edits`,
  );
}

const [which, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
if (which === 'create-default') await createDefault(args);
else if (which === 'oneshot-mac') oneshotMac(args);
else {
  console.error(
    'usage: sync.mjs create-default [--repo <dir>] | oneshot-mac --from <dir>',
  );
  process.exit(1);
}

#!/usr/bin/env node
// Grades what an agent built, in three layers, into <run>/grade.json:
//
//   hard gates  a clean `npm install` of its package.json works; the
//               grader's own smoke test mounts src/App headless, light and
//               dark, without a throw; nothing imports react-dom, Tailwind
//               or a web UI kit.
//   rules       what AGENTS.md and DESIGN.md ask for, checked: no hard-coded
//               colours, every control has a name, a MenuBar, a minimum
//               window size, no stretched buttons, none of the website look,
//               dark mode that is actually dark; plus the react-x11 errors
//               the agent ran into on the way (trap hits).
//   pictures    light.png and dark.png, rendered by the grader, for judge.mjs.
//
//   node evals/grade.mjs <batch dir | run dir>... [--force] [--keep-install]
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { agentNamed, readStream } from './lib/agents.mjs';
import { copyApp, npmInstall } from './lib/apps.mjs';
import {
  EVALS,
  childEnv,
  parseArgs,
  readJSON,
  runProcess,
  sh,
  writeJSON,
} from './lib/common.mjs';
import { scanSource, webDependencies } from './lib/static.mjs';
import { scanTraps } from './lib/traps.mjs';

/** A font file for `sans-serif`, so text measures the same on every run. */
export function gradingFont() {
  if (process.env.EVALS_FONT) return process.env.EVALS_FONT;
  if (process.platform === 'darwin')
    return '/System/Library/Fonts/Supplemental/Arial.ttf';
  if (process.platform === 'win32') return 'C:\\Windows\\Fonts\\segoeui.ttf';
  const r = sh('fc-match', ['sans-serif', '--format=%{file}']);
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : undefined;
}

/** Below this gap in mean luminance, "dark" rendered as light did. */
const DARK_GAP = 40;

/**
 * Grade one app.
 *
 * @param {object} o
 * @param {string} o.app       the app as the agent left it
 * @param {string} o.work      a scratch directory for the grader's copy
 * @param {string} o.shots     where light.png and dark.png go
 * @param {string} [o.nodeModules] link this instead of installing (controls)
 */
export async function gradeApp({
  app,
  work,
  shots,
  nodeModules,
  keepInstall = false,
}) {
  const copy = join(work, 'app');
  copyApp(app, copy);
  let install;
  if (nodeModules) {
    symlinkSync(nodeModules, join(copy, 'node_modules'));
    install = { ok: true, linked: true };
  } else {
    install = npmInstall(copy, join(work, 'install.log'));
  }
  copyFileSync(join(EVALS, 'lib/smoke.mjs'), join(copy, '.evals-smoke.mjs'));

  const font = gradingFont();
  const smoke = {};
  // HOME and the config dirs are a throwaway, so an app's createSettings or
  // fs writes land nowhere that matters
  const home = mkdtempSync(join(tmpdir(), 'react-x11-evals-home-'));
  for (const scheme of ['light', 'dark']) {
    if (!install.ok) {
      smoke[scheme] = { ok: false, error: 'not run: install failed' };
      continue;
    }
    const r = await runProcess(
      'node',
      [
        '--import',
        'tsx',
        '.evals-smoke.mjs',
        shots,
        scheme,
        ...(font ? [font] : []),
      ],
      {
        cwd: copy,
        env: childEnv({
          HOME: home,
          XDG_CONFIG_HOME: join(home, '.config'),
          XDG_DATA_HOME: join(home, '.local/share'),
          REACT_X11_NO_AUTORUN: '1',
        }),
        timeoutMs: 90_000,
      },
    );
    const out = join(shots, `smoke-${scheme}.json`);
    smoke[scheme] = existsSync(out)
      ? readJSON(out)
      : {
          ok: false,
          error: `smoke test exited ${r.code ?? r.signal}${r.timedOut ? ' (timed out)' : ''}: ${(r.stderr ?? '').slice(-1500)}`,
        };
  }
  rmSync(home, { recursive: true, force: true });

  const src = scanSource(copy);
  const pkg = readJSON(join(copy, 'package.json'), {});
  const webDeps = webDependencies(pkg);
  const installed = readJSON(
    join(copy, 'node_modules/react-x11/package.json'),
    null,
  );

  const L = smoke.light ?? {};
  const D = smoke.dark ?? {};
  const mounted = L.ok && D.ok;
  const gates = {
    install: install.ok,
    mountLight: Boolean(L.ok),
    mountDark: Boolean(D.ok),
    noWebImports: src.webImports.length === 0 && webDeps.length === 0,
  };
  const lumLight = L.pixels?.meanLuminance;
  const lumDark = D.pixels?.meanLuminance;
  const rules = {
    noHardcodedColours: src.hexColours.length + src.namedColours.length === 0,
    allControlsNamed: L.ok ? L.nameless.length === 0 : null,
    menuBar: src.menuBar || Boolean(L.menuBarInTree),
    minWidth: L.ok
      ? typeof L.window?.minWidth === 'number' && L.window.minWidth > 0
      : src.minWidthInSource,
    noWideButtons: L.ok ? L.wideButtons.length === 0 : null,
    noWebLook: L.ok
      ? src.gradients.length +
          src.emoji.length +
          src.className.length +
          L.heroText.length ===
          0 && L.shadowedCards < 3
      : null,
    followsDarkMode:
      mounted && typeof lumLight === 'number' && typeof lumDark === 'number'
        ? lumDark < lumLight - DARK_GAP
        : null,
  };
  const evaluated = Object.values(rules).filter((v) => v !== null);
  if (!keepInstall) rmSync(copy, { recursive: true, force: true });
  return {
    pass: Object.values(gates).every(Boolean),
    gates,
    rules,
    violations: evaluated.filter((v) => v === false).length,
    rulesEvaluated: evaluated.length,
    metrics: {
      hexColours: src.hexColours.length + src.namedColours.length,
      nameless: L.nameless?.length ?? null,
      focusables: L.focusables ?? null,
      wideButtons: L.wideButtons?.length ?? null,
      shadowedCards: L.shadowedCards ?? null,
      heroText: L.heroText?.length ?? null,
      gradients: src.gradients.length,
      emoji: src.emoji.length,
      className: src.className.length,
      bigRadius: src.bigRadius.length,
      lumLight: lumLight ?? null,
      lumDark: lumDark ?? null,
      window: L.window ?? null,
      sourceFiles: src.files,
      sourceLines: src.lines,
      usesComponents: src.componentsPackage,
    },
    details: {
      install: install.ok ? undefined : install.tail,
      smokeErrors: { light: L.error, dark: D.error },
      consoleErrors: {
        light: L.consoleErrors?.slice(0, 5),
        dark: D.consoleErrors?.slice(0, 5),
      },
      webImports: [
        ...src.webImports,
        ...webDeps.map((d) => ({ file: 'package.json', text: d })),
      ],
      hexColours: [...src.hexColours, ...src.namedColours].slice(0, 10),
      nameless: L.nameless?.slice(0, 10),
      wideButtons: L.wideButtons?.slice(0, 5),
      heroText: L.heroText,
      gradients: src.gradients.slice(0, 5),
      emoji: src.emoji.slice(0, 5),
    },
    font: font ?? null,
    reactX11Installed: installed?.version ?? null,
    shots: {
      light: existsSync(join(shots, 'light.png'))
        ? join(shots, 'light.png')
        : null,
      dark: existsSync(join(shots, 'dark.png'))
        ? join(shots, 'dark.png')
        : null,
    },
  };
}

/** Grade one run directory of a batch: the app, plus its transcript. */
export async function gradeRun(runDir, options = {}) {
  const cell = readJSON(join(runDir, 'cell.json'));
  const agentRun = readJSON(join(runDir, 'agent.json'), null);
  const graded = await gradeApp({
    app: join(runDir, 'app'),
    work: join(runDir, 'grade'),
    shots: join(runDir, 'shots'),
    keepInstall: options.keepInstall,
  });
  const events = readStream(join(runDir, 'transcript.jsonl'));
  const parsed = agentNamed(cell.agent).parse(events);
  const grade = {
    id: cell.id,
    variant: cell.variant,
    prompt: cell.prompt,
    set: cell.set,
    archetype: cell.archetype,
    run: cell.run,
    ...graded,
    traps: scanTraps(events),
    agent: {
      name: cell.agent,
      version: parsed.agentVersion ?? agentRun?.agentVersion ?? null,
      model: parsed.model,
      models: parsed.models,
      exit: agentRun?.exit ?? null,
      timedOut: agentRun?.timedOut ?? null,
      finished: parsed.finished,
      resultSubtype: parsed.resultSubtype,
      wallMs: agentRun?.wallMs ?? null,
      costUsd: parsed.costUsd,
      tokens: parsed.tokens,
      toolCalls: parsed.toolCalls,
      toolsByName: parsed.toolsByName,
      numTurns: parsed.numTurns,
      permissionDenials: parsed.permissionDenials,
    },
    setup: readJSON(join(runDir, 'setup.json'), null),
  };
  // paths in the result are relative to the run, so a batch can move
  for (const k of ['light', 'dark'])
    if (grade.shots[k]) grade.shots[k] = relative(runDir, grade.shots[k]);
  writeJSON(join(runDir, 'grade.json'), grade);
  return grade;
}

export function runDirsOf(target) {
  const abs = resolve(target);
  if (existsSync(join(abs, 'cell.json'))) return [abs];
  const runs = join(abs, 'runs');
  if (!existsSync(runs))
    throw new Error(`${target}: neither a run (cell.json) nor a batch (runs/)`);
  return readdirSync(runs)
    .map((d) => join(runs, d))
    .filter((d) => existsSync(join(d, 'cell.json')))
    .sort();
}

export const summary = (g) =>
  `${g.pass ? 'PASS' : 'FAIL'} ${g.id}: ` +
  `gates ${
    Object.entries(g.gates)
      .filter(([, v]) => !v)
      .map(([k]) => k)
      .join(',') || 'ok'
  }; ` +
  `${g.violations}/${g.rulesEvaluated} rules broken` +
  `${
    g.violations
      ? ` (${Object.entries(g.rules)
          .filter(([, v]) => v === false)
          .map(([k]) => k)
          .join(', ')})`
      : ''
  }` +
  `${g.traps ? `; ${g.traps.total} trap hits` : ''}`;

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  if (!args._.length) {
    console.error(
      'usage: grade.mjs <batch dir | run dir>... [--force] [--keep-install]',
    );
    process.exit(1);
  }
  for (const target of args._) {
    for (const dir of runDirsOf(target)) {
      if (!args.force && existsSync(join(dir, 'grade.json'))) continue;
      if (!existsSync(join(dir, 'agent.json'))) {
        console.log(`skip ${dir}: the agent has not run`);
        continue;
      }
      const g = await gradeRun(dir, { keepInstall: args.keepInstall });
      console.log(summary(g));
    }
  }
}

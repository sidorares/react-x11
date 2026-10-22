// The grader's own smoke test, which no agent sees: grade.mjs copies it into
// its copy of the app and runs it there once per colour scheme, so react-x11
// and React resolve from the app's own node_modules.
//
//   node --import tsx .evals-smoke.mjs <out dir> <light|dark> [font file]
//
// It mounts src/App (default export, or a named App) with react-x11/test,
// headless, and writes <scheme>.png and smoke-<scheme>.json: whether it
// mounted without a throw, the window's size and minimum, what a screen
// reader finds with no name, buttons stretched across the window, whether a
// MenuBar is there, and how the picture's pixels came out.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [outDir, scheme, fontFile] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const result = { scheme, ok: false, stage: 'import' };
const consoleErrors = [];
for (const level of ['error', 'warn']) {
  console[level] = (...args) => {
    if (consoleErrors.length < 30) {
      consoleErrors.push(
        `${level}: ${args
          .map((a) => a?.stack ?? String(a))
          .join(' ')
          .slice(0, 600)}`,
      );
    }
  };
}
process.on('unhandledRejection', (err) => {
  consoleErrors.push(
    `unhandledRejection: ${String(err?.stack ?? err).slice(0, 600)}`,
  );
});

function done(code = 0) {
  result.consoleErrors = consoleErrors;
  writeFileSync(
    join(outDir, `smoke-${scheme}.json`),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  process.exit(code);
}
// an app that never settles (a fetch, an infinite effect) still gets a verdict
setTimeout(
  () => {
    result.error = `timed out at stage "${result.stage}"`;
    done(0);
  },
  Number(process.env.EVALS_SMOKE_TIMEOUT_MS ?? 45_000),
).unref();

const describe = (node) => {
  let text = '';
  (function read(n, depth) {
    if (depth > 6 || text.length > 40) return;
    if (typeof n.text === 'string') text += n.text;
    for (const c of n.children ?? []) read(c, depth + 1);
  })(node, 0);
  return `<${node.kind}>${text ? ` "${text.trim().slice(0, 40)}"` : ''}`;
};

let t;
try {
  const React = (await import('react')).default;
  t = await import('react-x11/test');
  const entry = [
    'src/App.jsx',
    'src/App.tsx',
    'src/App.js',
    'src/app.jsx',
    'App.jsx',
  ]
    .map((f) => join(process.cwd(), f))
    .find((f) => existsSync(f));
  if (!entry) throw new Error('no src/App.jsx (or .tsx, .js) to mount');
  result.entry = entry.slice(process.cwd().length + 1);
  const mod = await import(pathToFileURL(entry).href);
  const App = mod.default ?? mod.App;
  if (!App)
    throw new Error(`${result.entry} exports neither a default nor an App`);

  result.stage = 'render';
  const fonts = fontFile ? { 'sans-serif': fontFile } : undefined;
  const r = await t.renderX11(React.createElement(App), {
    wrap: false,
    colorScheme: scheme,
    a11y: true,
    fonts,
  });
  // effects, a Suspense boundary, a first data load
  await t.act();
  await new Promise((res) => setTimeout(res, 500));
  await t.act();

  result.stage = 'inspect';
  const wn = r.windowNode;
  const width = Math.min(
    2400,
    Math.round(r.window?.width ?? wn?.abs?.width ?? 640),
  );
  const height = Math.min(
    1600,
    Math.round(r.window?.height ?? wn?.abs?.height ?? 480),
  );
  result.window = {
    width,
    height,
    title: wn?.props?.title ?? null,
    minWidth: wn?.props?.minWidth ?? null,
    minHeight: wn?.props?.minHeight ?? null,
  };

  const focusables = r.at.focusables();
  result.focusables = focusables.length;
  // controls only: a focusable container (ContextMenu's own wrapper is one)
  // with no name is counted apart, as it is not something a person operates
  const CONTAINERS = new Set([
    'filler',
    'panel',
    'scrollable',
    'scroll pane',
    'section',
    'group',
    'frame',
    'window',
  ]);
  const unnamed = focusables
    .filter((f) => !String(f.name ?? '').trim())
    .map((f) => ({ role: f.role, node: describe(f.node) }));
  result.nameless = unnamed.filter((f) => !CONTAINERS.has(f.role));
  result.namelessContainers = unnamed.filter((f) => CONTAINERS.has(f.role));

  const buttons = [];
  const hero = [];
  const cards = [];
  let menuBar = false;
  (function visit(node) {
    const role = t.roleOf(node);
    if (role === 'menubar') menuBar = true;
    if (role === 'button' && node.abs) buttons.push(node);
    const style = node.style ?? {};
    // a hero header: big words (not big digits: a timer is allowed those)
    // in the top third of the window
    if (
      node.kind === 'text' &&
      typeof style.fontSize === 'number' &&
      style.fontSize >= 26 &&
      node.abs &&
      node.abs.y < height * 0.35
    ) {
      const text = t.textOf(node).trim();
      if (/[A-Za-z]{3,}.*\s.*[A-Za-z]{3,}/.test(text))
        hero.push({ text: text.slice(0, 60), fontSize: style.fontSize });
    }
    // card soup: rounded, shadowed boxes
    if (
      style.boxShadow &&
      style.boxShadow !== 'none' &&
      Number(style.borderRadius) >= 8
    ) {
      cards.push(describe(node));
    }
    for (const c of node.children ?? []) visit(c);
  })(wn);
  result.menuBarInTree = menuBar;
  result.buttons = buttons.length;
  // the column-stretch trap: a button as wide as the column it sits in.
  // The column is the nearest ancestor wider than the button (a Button's
  // own slot is as wide as it is).
  const columnOf = (node) => {
    let p = node.parent;
    while (p && p.abs && p.abs.width <= node.abs.width + 1 && !p.isWindow)
      p = p.parent;
    return p?.abs ? p : null;
  };
  result.wideButtons = buttons
    .map((b) => ({ b, column: columnOf(b) }))
    .filter(
      ({ b, column }) =>
        b.abs.width >= 160 && column && b.abs.width >= column.abs.width * 0.8,
    )
    .map(({ b, column }) => ({
      node: describe(b),
      width: Math.round(b.abs.width),
      column: Math.round(column.abs.width),
    }));
  result.heroText = hero;
  result.shadowedCards = cards.length;

  result.stage = 'screenshot';
  const file = join(outDir, `${scheme}.png`);
  const png = await t.toPNG(r.ctx, file, { width, height });
  result.png = file;
  try {
    const { PNG } = await import('pngjs');
    const { data } = PNG.sync.read(png);
    const counts = new Map();
    let lum = 0;
    const n = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      const [rr, gg, bb] = [data[i], data[i + 1], data[i + 2]];
      lum += 0.2126 * rr + 0.7152 * gg + 0.0722 * bb;
      const key = (rr << 16) | (gg << 8) | bb;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    result.pixels = {
      meanLuminance: Math.round(lum / n),
      dominantShare:
        Math.round((Math.max(...counts.values()) / n) * 1000) / 1000,
      colours: counts.size,
    };
  } catch (err) {
    result.pixels = { error: String(err.message ?? err) };
  }
  result.ok = true;
  result.stage = 'done';
} catch (err) {
  result.error = String(err?.stack ?? err).slice(0, 4000);
}
try {
  await Promise.race([
    t?.cleanup(),
    new Promise((res) => setTimeout(res, 3000)),
  ]);
} catch {
  // the verdict is written either way
}
done(0);

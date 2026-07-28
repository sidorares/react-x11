// Click-to-component: Alt+Click a rendered element to open the exact JSX
// line that created it in your editor. Opt-in via REACT_X11_CLICK_TO_COMPONENT
// (see docs/click-to-component.md); wired up from Reconciler.js the same way
// REACT_X11_DEVTOOLS wires up DevToolsIntegration.js.
//
// Unlike DOM click-to-component tools this needs no babel/jsx-source plugin
// and no source-map resolution of its own: React 19 already captures a real
// `Error` (fiber._debugStack) at every JSX call site in development mode,
// and Node's `--enable-source-maps` (which tsx and this repo's hot-reload
// loader both enable) has already rewritten that Error's stack to point at
// original source — we only have to parse the stack text and skip the
// frames inside React/the reconciler itself.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setClickToComponentHandler } from './events.js';

const STACK_FRAME = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/;

/** The first stack frame outside React/the reconciler/node internals — the
 * user's own JSX call site for whatever element this Error was captured at. */
function resolveLocation(debugStack) {
  const stack = debugStack?.stack;
  if (!stack) return null;
  for (const line of stack.split('\n').slice(1)) {
    const match = line.match(STACK_FRAME);
    if (!match) continue;
    const [, functionName, rawFile, lineStr, columnStr] = match;
    if (
      rawFile.includes('/node_modules/') ||
      rawFile.startsWith('node:') ||
      rawFile === '<anonymous>'
    ) {
      continue;
    }
    const file = rawFile.startsWith('file://')
      ? fileURLToPath(rawFile)
      : rawFile;
    return {
      functionName,
      file,
      line: Number(lineStr),
      column: Number(columnStr),
    };
  }
  return null;
}

function componentName(fiber) {
  const owner = fiber._debugOwner;
  const type = owner?.type;
  if (type) return type.displayName || type.name || '(anonymous)';
  return typeof fiber.type === 'string' ? `<${fiber.type}>` : '(unknown)';
}

/** Alt+Shift+Click: who-rendered-who, from the clicked element up to the
 * root, each with its own source location — handy when the immediate owner
 * isn't the component you meant (a shared wrapper, a list item, ...). */
function logOwnerChain(fiber) {
  const chain = [];
  for (let owner = fiber._debugOwner; owner; owner = owner._debugOwner) {
    const location = resolveLocation(owner._debugStack);
    const name = owner.type?.displayName || owner.type?.name || '(anonymous)';
    chain.push(
      location
        ? `${name} (${location.file}:${location.line}:${location.column})`
        : name,
    );
  }
  if (chain.length > 0) {
    console.log('[click-to-component] owner chain:\n  ' + chain.join('\n  '));
  }
}

// GUI editors: navigate their registered URI scheme (same idea as
// https://github.com/sidorares/show-component, minus the browser) instead of
// spawning their CLI shim. The CLI wrapper (e.g. `cursor -g ...`) round-trips
// through a shell script that re-detects and re-execs the real app, which is
// visibly slower than the OS handing the URL straight to the already-running
// instance via Launch Services (macOS) / xdg-open (Linux).
const EDITOR_SCHEMES = {
  cursor: 'cursor',
  code: 'vscode',
  vscode: 'vscode',
  'code-insiders': 'vscode-insiders',
  'vscode-insiders': 'vscode-insiders',
  windsurf: 'windsurf',
};

// Terminal editors have no URI scheme to navigate — spawn them directly.
const EDITOR_CLI = {
  vim: (file, line, column) => [
    'vim',
    [`+call cursor(${line},${column})`, file],
  ],
  nvim: (file, line, column) => [
    'nvim',
    [`+call cursor(${line},${column})`, file],
  ],
};

const OPEN_URI_COMMAND = process.platform === 'darwin' ? 'open' : 'xdg-open';

function editorUri(scheme, file, line, column) {
  return `${scheme}://file${encodeURI(file)}:${line}:${column}`;
}

function openInEditor({ file, line, column }) {
  const name = process.env.REACT_X11_EDITOR || 'cursor';
  let bin, args;
  if (EDITOR_CLI[name]) {
    [bin, args] = EDITOR_CLI[name](file, line, column);
  } else {
    // an unrecognized name is assumed to be a URI scheme itself, so any
    // editor that registers one works without a matching entry above
    const scheme = EDITOR_SCHEMES[name] || name;
    bin = OPEN_URI_COMMAND;
    args = [editorUri(scheme, file, line, column)];
  }
  const child = spawn(bin, args, { detached: true, stdio: 'ignore' });
  child.on('error', (err) => {
    console.warn(
      `react-x11: click-to-component could not launch "${bin}" (${err.code ?? err.message}). ` +
        'Set REACT_X11_EDITOR to your editor CLI (cursor, code, code-insiders, windsurf, vim, nvim).',
    );
  });
  child.unref();
}

/** Briefly tint the clicked node so there is visual confirmation of what was
 * resolved, reusing the same overlay the DevTools hover highlight paints. */
function flashHighlight(node) {
  const root = node?.root;
  if (typeof root?.setHighlight !== 'function') return;
  root.setHighlight(node);
  setTimeout(() => root.setHighlight(null), 300);
}

function handleClick(node, native) {
  const fiber = node?._reactFiber;
  if (!fiber) {
    console.warn(
      'react-x11: click-to-component — this element has no fiber info.',
    );
    return;
  }
  const location = resolveLocation(fiber._debugStack);
  if (!location) {
    console.warn(
      'react-x11: click-to-component — no source location found. This needs ' +
        'React running in development mode (fiber._debugStack).',
    );
    return;
  }
  console.log(
    `[click-to-component] ${componentName(fiber)} → ` +
      `${location.file}:${location.line}:${location.column}`,
  );
  if (native?.buttons & 1) {
    // Alt+Shift+Click
    logOwnerChain(fiber);
  }
  flashHighlight(node);
  openInEditor(location);
}

// The bit checked in events.js is X11's Mod1Mask either way — this is only
// about what the user actually has to press. XQuartz maps the Option key to
// Mod1 by default ("Option keys send Alt_L and Alt_R" in its Input
// preferences); everywhere else Mod1 is the physical Alt key.
const MODIFIER_LABEL = process.platform === 'darwin' ? 'Option' : 'Alt';

export function install() {
  setClickToComponentHandler(handleClick);
  console.log(
    `react-x11: click-to-component enabled — ${MODIFIER_LABEL}+Click an ` +
      `element to open its source (${MODIFIER_LABEL}+Shift+Click also logs ` +
      'the owner chain).',
  );
}

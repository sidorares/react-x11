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
import { setClickToComponentHandler } from './events.js';
import { selectInDevTools } from './DevToolsIntegration.js';
import { openInEditor, stackFrames } from './editor.js';

/** The first stack frame outside React/the reconciler/node internals — the
 * JSX call site for whatever element this Error was captured at, wherever it
 * was written. `installed` marks a call site that lives inside an installed
 * package rather than in the application's own source.
 * Exported because `react-x11/test`'s `sourceOf` answers the same question
 * for a test that a click answers for an editor. */
export function resolveLocation(debugStack) {
  const frame = stackFrames(debugStack?.stack).find((f) => !f.internal);
  if (!frame) return null;
  const { functionName, file, line, column, installed } = frame;
  return {
    functionName: functionName ?? undefined,
    file,
    line,
    column,
    installed,
  };
}

/** The nearest source location a click can mean: the clicked element's own
 * JSX call site when the application wrote it, and otherwise the first owner
 * up the chain that it did write. An element rendered by an installed
 * component — a design system's `<Toolbar>`, a chart library's internals —
 * has its call site inside that package; what the user meant by clicking it
 * is the `<Toolbar ... />` line in their own file that put it on screen.
 *
 * Returns `{ fiber, location, depth }`, `depth` being how many owners up the
 * location came from (0 = the clicked element's own). Falls back to the
 * nearest installed call site when nothing in the chain is application
 * source — opening a package's own file beats refusing to open anything —
 * and null only when React has no debug info at all. */
export function resolveOwnedLocation(fiber) {
  let fallback = null;
  let depth = 0;
  for (let owner = fiber; owner; owner = owner._debugOwner, depth++) {
    const location = resolveLocation(owner._debugStack);
    if (!location) continue;
    if (!location.installed) return { fiber: owner, location, depth };
    fallback ??= { fiber: owner, location, depth };
  }
  return fallback;
}

/** What the clicked thing *is* — `<box>` for a host node, the component's
 * name for a composite one. (`componentName` below answers a different
 * question: who *wrote* it.) */
function elementLabel(fiber) {
  const type = fiber.type;
  if (typeof type === 'string') return `<${type}>`;
  return type?.displayName || type?.name || '(anonymous)';
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
  const resolved = resolveOwnedLocation(fiber);
  if (!resolved) {
    console.warn(
      'react-x11: click-to-component — no source location found for this ' +
        'element or any of its owners. This needs React running in ' +
        'development mode (fiber._debugStack).',
    );
    return;
  }
  const { fiber: sourceFiber, location, depth } = resolved;
  // What was clicked is not always what has a source: say so rather than
  // silently opening a file the click doesn't obviously correspond to.
  const climbed =
    depth > 0
      ? ` (${depth} owner${depth > 1 ? 's' : ''} up from the clicked ` +
        `${elementLabel(fiber)})`
      : '';
  const installed = location.installed ? ' — inside an installed package' : '';
  console.log(
    `[click-to-component] ${componentName(sourceFiber)} → ` +
      `${location.file}:${location.line}:${location.column}` +
      climbed +
      installed,
  );
  if (native?.buttons & 1) {
    // Alt+Shift+Click
    logOwnerChain(fiber);
  }
  // With DevTools attached, the click that says which element this is says
  // it there too — the tree jumps to the component instead of the user
  // hunting for the row they just clicked. Nothing to do when it is not.
  selectInDevTools(node);
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

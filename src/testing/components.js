// The component layer of `react-x11/test`: which component made this node,
// with what props and hooks — and set that state through React's own
// machinery rather than by poking at internals.
//
// Two layers, with different requirements:
//
// **The fiber layer** (`ownerChainOf`, `sourceOf`, the `ByComponent`
// queries) reads what development React already records on every fiber: the
// JSX owner chain (`_debugOwner`) and the call-site Error (`_debugStack`).
// Every retained node keeps its host fiber (`node._reactFiber`, set in
// Reconciler.createInstance), so this needs no dependency and no setup —
// only React in development mode, which a test run is.
//
// **The inspection layer** (`inspect`, and the `setHook` it hands out)
// drives the React DevTools backend — the same code the standalone DevTools
// app talks to — entirely in this process. `injectIntoDevTools()` parks a
// full renderer interface on the global hook before any bridge, agent or
// socket exists, and that interface is the expensive-to-own half of
// DevTools: hook trees with names and source locations (react-debug-tools),
// and overrides that go through `enqueueConcurrentRenderForLane` so React
// actually re-renders. The WebSocket transport of docs/devtools.md is the
// half this deliberately skips: nothing here opens a socket or listens on
// anything, and `ws` is never imported. It needs the `react-devtools-core`
// package (a devDependency here; add it to yours) — the fiber layer works
// without it.

import { Renderer } from '../Reconciler.js';
import Reflection from 'react-reconciler/reflection.js';
import { resolveLocation } from '../ClickToComponent.js';
import { act, mountedEntries } from './harness.js';

const { findCurrentFiberUsingSlowPath } = Reflection;

// ---------------------------------------------------------------------------
// The fiber layer
// ---------------------------------------------------------------------------

/** The display name of a fiber's type: function and class components, and
 * the memo/forwardRef wrappers around them. Null for hosts and everything
 * else — which is what lets the owner walks below skip non-components. */
function fiberTypeName(type) {
  if (typeof type === 'function') return type.displayName || type.name || null;
  if (typeof type === 'object' && type !== null) {
    // memo(Component) keeps the inner type on `.type`, forwardRef on
    // `.render`; either way the name lives on the inner function
    return type.displayName || fiberTypeName(type.render ?? type.type) || null;
  }
  return null;
}

/**
 * The components that created this node, nearest first — `['Label',
 * 'TaskRow', 'App']`. This is React's JSX owner chain (who *wrote* the
 * element), not tree ancestry: content passed as children belongs to the
 * component whose JSX it appears in, which is the answer a failing test
 * wants. Empty outside development mode, where React records no owners.
 */
export function ownerChainOf(node) {
  const names = [];
  for (
    let owner = node?._reactFiber?._debugOwner;
    owner;
    owner = owner._debugOwner
  ) {
    const name = fiberTypeName(owner.type);
    if (name) names.push(name);
  }
  return names;
}

/**
 * The source location of the JSX that created this node — `{ file, line,
 * column }` — from the call-site Error development React captures on every
 * element. The same resolution click-to-component uses for the editor jump.
 */
export function sourceOf(node) {
  return resolveLocation(node?._reactFiber?._debugStack) ?? null;
}

function componentMatches(name, expected) {
  if (expected instanceof RegExp) return expected.test(name);
  if (typeof expected === 'function') return Boolean(expected(name));
  return name === String(expected);
}

function nearestMatchingOwner(node, expected) {
  for (
    let owner = node?._reactFiber?._debugOwner;
    owner;
    owner = owner._debugOwner
  ) {
    const name = fiberTypeName(owner.type);
    if (name && componentMatches(name, expected)) return owner;
  }
  return null;
}

// A fiber and its alternate are the same component instance; two nodes
// created in different renders can hold either half of the pair.
function sameInstance(a, b) {
  return a === b || (b != null && a === b.alternate);
}

/**
 * The host roots of every rendered instance of a component: for each
 * instance, the topmost host nodes of its output, in paint order. That is
 * the node `within()` wants next — scoping to it covers the instance's
 * whole subtree, slotted children included, the way a container does.
 */
export function queryAllByComponent(root, expected) {
  const found = [];
  const visit = (node, parentOwner) => {
    if (!node || node.destroyed) return;
    const owner = nearestMatchingOwner(node, expected);
    // A node whose matching owner is the same instance as its host
    // parent's is interior to output already collected. Children created
    // by the instance's own render props inherit it through `parentOwner`.
    if (owner && !sameInstance(owner, parentOwner)) found.push(node);
    for (const child of node.children ?? []) {
      visit(child, owner ?? parentOwner);
    }
  };
  visit(root, null);
  return found;
}

/** What a ByComponent miss prints: the component names that *are* in the
 * tree, which is the list the caller was trying to spell one of. */
export function componentInventory(root, limit = 12) {
  const names = new Set();
  const visit = (node) => {
    if (!node || node.destroyed) return;
    for (
      let owner = node._reactFiber?._debugOwner;
      owner;
      owner = owner._debugOwner
    ) {
      const name = fiberTypeName(owner.type);
      if (name) names.add(name);
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
  if (names.size === 0) {
    return '  (no components — is React running in development mode?)';
  }
  return [...names]
    .slice(0, limit)
    .map((name) => `  <${name}>`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// The inspection layer
// ---------------------------------------------------------------------------

let devtoolsReady = null;

/**
 * Install the DevTools global hook and register the renderer, once, and
 * hand back the backend's renderer interface. No socket: installing the
 * hook is `initialize()`; the interface appears at `injectIntoDevTools()`;
 * `connectToDevTools` — the WebSocket half — is simply never called. If the
 * app under test already enabled REACT_X11_DEVTOOLS, its interface is
 * reused rather than injecting the renderer a second time.
 */
function rendererInterface() {
  if (devtoolsReady) return devtoolsReady;
  devtoolsReady = (async () => {
    let hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!hook?.rendererInterfaces?.size) {
      // the backend bundle expects browser-ish globals, exactly as
      // DevToolsIntegration.prepare() shims them
      global.self ??= global;
      global.window ??= global;
      let mod;
      try {
        mod = await import('react-devtools-core');
      } catch (err) {
        throw new Error(
          'react-x11/test: inspect() drives the React DevTools backend ' +
            'in-process, which needs the react-devtools-core package — ' +
            'add it to your devDependencies. Original error: ' +
            err.message,
          { cause: err },
        );
      }
      const api = mod.default?.initialize ? mod.default : mod;
      // The backend can also patch console (component stacks appended to
      // console.error, and so on). A test harness must not: every setting
      // that touches console goes in off.
      api.initialize({
        appendComponentStack: false,
        breakOnConsoleErrors: false,
        showInlineWarningsAndErrors: false,
        hideConsoleLogsInStrictMode: false,
      });
      hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
      Renderer.injectIntoDevTools();
    }
    const interfaces = [...hook.rendererInterfaces.values()];
    const ri = interfaces[interfaces.length - 1];
    // The backend queues every commit's tree deltas for a frontend that
    // will never attach here; one flush (to no listeners) discards the
    // queue and stops it growing for the rest of the run.
    ri.flushInitialOperations();
    return ri;
  })();
  return devtoolsReady;
}

/** The reconciler internals the hook holds for our renderer —
 * `scheduleUpdate` and friends. Dev builds only. */
function rendererInternals() {
  const renderers = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__?.renderers;
  if (!renderers?.size) return null;
  return [...renderers.values()][renderers.size - 1];
}

/**
 * The backend only observes commits, so a root mounted before the hook
 * existed — the normal case, since the hook installs lazily on the first
 * `inspect()` — is invisible until its next commit. One re-render commit
 * per unobserved root brings its whole tree in; `scheduleUpdate` is the
 * same internals call DevTools itself uses to apply an override.
 */
async function refreshUnobservedRoots(ri) {
  const internals = rendererInternals();
  if (typeof internals?.scheduleUpdate !== 'function') return;
  for (const entry of mountedEntries()) {
    const node = entry.windowNode;
    if (!node || node.destroyed) continue;
    if (ri.getElementIDForHostInstance(node) != null) continue;
    const fiber = node._reactFiber;
    if (!fiber) continue;
    await act(() => internals.scheduleUpdate(fiber), entry);
  }
}

async function resolveElementID(ri, node) {
  let id = ri.getElementIDForHostInstance(node);
  if (id == null) {
    await refreshUnobservedRoots(ri);
    id = ri.getElementIDForHostInstance(node);
  }
  return id ?? null;
}

/**
 * The current-generation fiber of the inspected component, found by
 * walking tree ancestry from the node until the display name DevTools
 * reported matches. Values are read from this fiber, so they are the
 * committed ones — the node's own `_reactFiber` was captured at mount and
 * may be the retired half of the alternate pair, one render behind.
 * Null when no ancestor carries that name (an exotic wrapper, say) — the
 * caller then falls back to DevTools' own value copies.
 */
function currentComponentFiber(node, displayName) {
  let fiber = node?._reactFiber ?? null;
  if (!fiber || displayName == null) return null;
  try {
    fiber = findCurrentFiberUsingSlowPath(fiber) ?? fiber;
  } catch {
    // detached or mid-update — read from the captured generation instead
  }
  for (let f = fiber; f; f = f.return) {
    if (fiberTypeName(f.type) === displayName) return f;
  }
  return null;
}

/** The value in the component's Nth hook slot — `id` is React's own index
 * over the hooks that occupy one, which is how the override path addresses
 * them too. For useState/useReducer the slot's `memoizedState` *is* the
 * value; only they are read this way. */
function hookSlotValue(fiber, nativeIndex, fallback) {
  let slot = fiber.memoizedState;
  for (let i = 0; i < nativeIndex && slot; i++) slot = slot.next ?? null;
  return slot ? slot.memoizedState : fallback;
}

function mapHooks(data, fiber) {
  if (!Array.isArray(data)) return [];
  const map = (h) => ({
    id: h.id ?? null,
    name: h.name,
    // live value for the editable hooks; DevTools' copy (primitives exact,
    // deep objects as previews) for the rest
    value:
      h.isStateEditable && h.id != null && fiber
        ? hookSlotValue(fiber, h.id, h.value)
        : h.value,
    editable: h.isStateEditable === true,
    source: h.hookSource
      ? {
          file: h.hookSource.fileName,
          line: h.hookSource.lineNumber,
          column: h.hookSource.columnNumber,
        }
      : null,
    subHooks: Array.isArray(h.subHooks) ? h.subHooks.map(map) : [],
  });
  return data.map(map);
}

let inspectRequestID = 0;

/**
 * The React side of a node: the nearest mounted component above it (the
 * one DevTools would select), its live props, its hooks — named and with
 * source locations, via react-debug-tools — and `setHook` to change what
 * useState/useReducer hold.
 *
 * Two costs to know about. Reading hooks **re-invokes the component's
 * render function** (under a stub dispatcher, output discarded) — that is
 * how react-debug-tools recovers hook names, and a render-counting test
 * will see it. And the nearest component is tree ancestry, where
 * `ownerChainOf`/`getByComponent` are JSX ownership; the two differ for
 * content passed as children.
 */
export async function inspect(target) {
  if (!target || typeof target !== 'object' || !target._reactFiber) {
    throw new Error(
      'react-x11/test: inspect() takes a rendered node, the kind a query ' +
        'returns.',
    );
  }
  const ri = await rendererInterface();
  const id = await resolveElementID(ri, target);
  if (id == null) {
    throw new Error(
      'react-x11/test: inspect() could not map this node to a component — ' +
        'it may have unmounted, or React is not in development mode.',
    );
  }
  const res = ri.inspectElement(++inspectRequestID, id, null, true);
  if (res.type !== 'full-data') {
    const detail = res.message ? ` — ${res.message}` : '';
    throw new Error(
      `react-x11/test: inspect() failed with "${res.type}"${detail}`,
    );
  }
  const v = res.value;
  const name = ri.getDisplayNameForElementID(id);
  const fiber = currentComponentFiber(target, name);
  const hooks = mapHooks(v.hooks?.data, fiber);

  return {
    /** DevTools' element id — stable for the life of the instance. */
    id,
    name,
    /** The component's live props object. Treat it as read-only: to render
     * with different props, render with different props. */
    props: fiber ? fiber.memoizedProps : (v.props?.data ?? null),
    /** Class component state; null for function components. */
    state: fiber?.tag === 1 ? fiber.memoizedState : (v.state?.data ?? null),
    /** Legacy class context only — a `useContext` value appears among the
     * hooks instead, and is not settable (wrap a provider). */
    context: v.context?.data ?? null,
    hooks,
    /** Owner names, nearest first — who rendered this component. */
    owners: Array.isArray(v.owners)
      ? v.owners.map((o) => o.displayName).filter(Boolean)
      : [],

    /**
     * Set a useState/useReducer value: `setHook(id, value)` or
     * `setHook(id, path, value)` for a path inside it. `id` is the hook's
     * `id` as listed in `hooks` — an index the Rules of Hooks fix for the
     * life of the component, so validating against this snapshot cannot go
     * stale. The write goes through the reconciler's own override path
     * (the one DevTools uses), inside `act()`, so React has re-rendered
     * and repainted by the time the promise resolves. A reducer is
     * bypassed, not driven: the value is placed, no action runs.
     */
    async setHook(hookID, ...rest) {
      const [path, value] = rest.length >= 2 ? rest : [[], rest[0]];
      if (!v.canEditHooks) {
        throw new Error(
          'react-x11/test: this reconciler build exposes no hook ' +
            'overrides — setHook() needs react-reconciler in development ' +
            'mode (NODE_ENV not "production").',
        );
      }
      const flat = [];
      const collect = (list) => {
        for (const h of list) {
          flat.push(h);
          collect(h.subHooks);
        }
      };
      collect(hooks);
      const hit = flat.find((h) => h.id === hookID);
      if (!hit || !hit.editable) {
        const editable = flat
          .filter((h) => h.editable)
          .map(
            (h) =>
              `  ${h.id}: ${h.name}` +
              (h.source ? ` (${h.source.file}:${h.source.line})` : ''),
          );
        throw new Error(
          `react-x11/test: hook ${hookID} ` +
            (hit
              ? `is a ${hit.name} hook — only useState/useReducer state ` +
                'can be set'
              : 'does not exist on this component') +
            `. Editable hooks:\n${editable.join('\n') || '  (none)'}`,
        );
      }
      await act(() => ri.overrideValueAtPath('hooks', id, hookID, path, value));
    },
  };
}

// The react-reconciler host config plus the public render entry points.
// Host instances are the retained nodes from nodes.js; only <window> and
// <popup> map to real X11 windows (see NEXT_STEPS.md), and those windows
// are created top-down in the commit phase (WindowNode.realize) so every
// CreateWindow names its actual parent from the start — createInstance
// performs no X11 calls, since the render phase is discardable (issue #4).
import { createRequire } from 'node:module';
import React from 'react';
import ReactReconciler from 'react-reconciler';
import { createClient } from 'ntk';

import {
  ConcurrentRoot,
  getCurrentUpdatePriority,
  setCurrentUpdatePriority,
  resolveUpdatePriority,
  setSyncFlush,
} from './priority.js';
import {
  WindowNode,
  PopupNode,
  BoxNode,
  TextNode,
  TextChunkNode,
  ImageNode,
  CanvasNode,
  TextInputNode,
  TextAreaNode,
  appearanceChanged,
  beginWindowMaps,
  flushWindowMaps,
  flushWindowRestacks,
  windowAttributes,
} from './nodes.js';
import { hasDropProps } from './dnd.js';
import { AppProvider } from './appcontext.js';
import {
  defaultRootHandlers,
  setErrorHandler,
  STRICT_TOKENS,
} from './errors.js';
import {
  registerApp,
  unregisterApp,
  hooks as traceHooks,
} from './trace-registry.js';
import { hooks as a11yHooks, startA11y } from './a11y.js';
import { beginStartup } from './startup.js';
import { beginCompose } from './compose.js';
import { beginFocus } from './events.js';
import { beginKeyboard } from './keyboard.js';
import { beginCompositing, endCompositing } from './compositing.js';
import { beginScreens, endScreens } from './screens.js';
import { beginScale, scaleOf } from './scale.js';
import { beginDesktopSettings, endDesktopSettings } from './desktopsettings.js';
import { endIdle } from './idle.js';
import { endKeyboardState } from './keyboardstate.js';
import { endXSettings } from './xsettings.js';
import { watchAppearance } from './appearance.js';
import { setDesktopIntegration } from './desktopintegration.js';
import { ForeignNode } from './foreignnodes.js';
import { GlAreaNode } from './glnodes.js';
import { createRegisteredNode, registeredElements } from './registry.js';
import { SvgNode, SvgChildNode } from './svgnodes.js';
import { loadLayout } from './yoga.js';

// The renderer name and version DevTools shows. Read from package.json so
// they cannot drift — but **guarded**, because a single-file bundle has no
// package.json beside it to read: `import.meta.url` is then the bundle's,
// `'../package.json'` resolves to something else or to nothing, and an
// unguarded require takes the whole app down at import time with
// `Cannot find module '../package.json'`. Losing the version string in a
// bundle costs a line in the DevTools panel; throwing costs the app. See
// docs/packaging.md.
const PACKAGE_NAME = 'react-x11';
let PACKAGE_VERSION = '0.0.0-bundled';
try {
  PACKAGE_VERSION = createRequire(import.meta.url)('../package.json').version;
} catch {
  // bundled, or installed somewhere without the manifest beside us
}

// The vocabulary, in the order the unknown-element error lists it. Exported
// so a test can sweep every element rather than a list of them that was
// true once (test/element-props.test.js).
export const HOST_TYPES = [
  'window',
  'popup',
  'box',
  'text',
  'image',
  'canvas',
  'textinput',
  'textarea',
  'svg',
  'glarea',
  'foreign',
];

const HostConfig = {
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  supportsResources: false,
  supportsSingletons: false,
  // Queries live in `react-x11/test` and walk the retained node tree
  // directly, which keeps the failure messages ours and keeps them off
  // react-reconciler's internal host-config contract. React's own selectors
  // would need eight more functions to answer the same questions.
  supportsTestSelectors: false,
  supportsMicrotasks: true,
  isPrimaryRenderer: true,
  // (`warnsIfNotActing` used to sit here. react-reconciler 0.33 reads it as
  // a bare expression statement and discards it — the act warning is gated
  // on `globalThis.IS_REACT_ACT_ENVIRONMENT`, which `react-x11/test`'s `act`
  // sets. A flag that does nothing is worse than no flag.)

  // What DevTools shows for this renderer. These are the whole story in
  // react-reconciler 0.33: `injectIntoDevTools()` takes no arguments and
  // reads them from here.
  rendererVersion: PACKAGE_VERSION,
  rendererPackageName: PACKAGE_NAME,
  // Surfaces as `internals.rendererConfig`, which is where a renderer puts
  // things only its own DevTools integration understands — React Native's
  // `getInspectorDataForViewTag` is the archetype. Nothing in the standalone
  // DevTools reads it for a renderer like this one, so there is nothing
  // honest to put here. In particular `findFiberByHostInstance` does not
  // belong here: 0.33 dropped it, and DevTools 7 only ever tested it for
  // *presence*, to tell a fiber renderer from the pre-fiber kind.
  extraDevToolsConfig: null,

  scheduleTimeout: setTimeout,
  cancelTimeout: clearTimeout,
  noTimeout: -1,
  scheduleMicrotask: queueMicrotask,

  getRootHostContext() {
    return {
      isInsideText: false,
      isInsideSvg: false,
      isInside3d: false,
    };
  },

  getChildHostContext(parentHostContext, type) {
    return {
      isInsideText: parentHostContext.isInsideText || type === 'text',
      // <svg> children are declarative SVG elements, not react-x11 nodes
      isInsideSvg: parentHostContext.isInsideSvg || type === 'svg',
      // inside <glarea> the children are scene nodes, not drawn nodes
      isInside3d: parentHostContext.isInside3d || type === 'glarea',
    };
  },

  getPublicInstance(instance) {
    // Refs attach in the layout phase, after the mutation phase realized
    // the window, so for windows this is the live ntk window.
    return instance.isWindow ? instance.window || instance : instance;
  },

  prepareForCommit() {
    // …so that a <window> realized during the mutation phase waits to be
    // mapped until React has finished hiding whatever it hides (nodes.js,
    // beginWindowMaps)
    beginWindowMaps();
    traceHooks.commitStart?.();
    return null;
  },

  // child <window>s that moved in the tree restack here, so a reorder costs
  // one pass instead of one per insertBefore.
  resetAfterCommit() {
    flushWindowRestacks();
    // after the restacking, so a subtree of windows arrives on screen in its
    // final order rather than shuffling once it is up
    flushWindowMaps();
    traceHooks.commitEnd?.();
    // the AT-SPI bridge flushes its queued tree/state diffs per commit
    a11yHooks.commit?.();
  },

  createInstance(type, props, rootContainer, hostContext, internalHandle) {
    if (hostContext.isInsideSvg) {
      // Inside <svg> every element is a declarative SVG element (React-DOM
      // style: <circle cx={12} strokeWidth={2} />); SvgView skips tags it
      // does not support.
      const node = new SvgChildNode(type, props, rootContainer);
      node._reactFiber = internalHandle;
      return node;
    }
    if (hostContext.isInsideText && type !== 'text') {
      throw new Error(
        `react-x11: <${type}> is not allowed inside <text>; only nested ` +
          '<text> spans and strings are.',
      );
    }
    if (hostContext.isInside3d) {
      // `<glarea>` is a leaf here: it owns the surface, the frame clock and
      // the swap, and `onDraw` is the escape hatch. A *scene graph* over it
      // — meshes, materials, lights, post-processing, on either backend —
      // is `@react-x11/components/three`, which brings its own reconciler.
      throw new Error(
        `react-x11: <${type}> is not an element — <glarea> takes no ` +
          'children. Draw through `onDraw`, or use ' +
          '`@react-x11/components/three` for a scene graph. See docs/gl.md.',
      );
    }
    let node;
    switch (type) {
      case 'window':
        // No X11 calls here: the render phase may be discarded. The real
        // window is created top-down in the commit phase (realize).
        node = new WindowNode(
          rootContainer,
          windowAttributes(props, scaleOf(rootContainer)),
          props,
        );
        break;
      case 'popup':
        node = new PopupNode(
          rootContainer,
          windowAttributes(props, scaleOf(rootContainer)),
          props,
        );
        break;
      case 'box':
        node = new BoxNode(props, rootContainer);
        break;
      case 'textinput':
        node = new TextInputNode(props, rootContainer);
        break;
      case 'textarea':
        node = new TextAreaNode(props, rootContainer);
        break;
      case 'text':
        node = new TextNode(props, rootContainer, {
          span: hostContext.isInsideText,
        });
        break;
      case 'image':
        node = new ImageNode(props, rootContainer);
        break;
      case 'canvas':
        node = new CanvasNode(props, rootContainer);
        break;
      case 'svg':
        node = new SvgNode(props, rootContainer);
        break;
      case 'glarea':
        node = new GlAreaNode(props, rootContainer);
        break;
      case 'foreign':
        // No X11 calls here either, and for a sharper reason than
        // `<window>`'s: the window this element embeds belongs to another
        // process, and a reparent issued from a render React then discards
        // has moved it for real. WindowNode.realize does it in the commit
        // phase (`_realizeChildWindows`).
        node = new ForeignNode(props, rootContainer);
        break;
      default: {
        // Third-party elements (issue #125). Built-ins stay a switch —
        // they are code, not data — and the registry is consulted only
        // once the switch has run out, so it costs nothing on the way in.
        const registered = createRegisteredNode(
          type,
          props,
          rootContainer,
          hostContext,
        );
        if (registered) {
          registered._reactFiber = internalHandle;
          return registered;
        }
        const custom = registeredElements();
        throw new Error(
          `react-x11: unknown element type <${type}>. Supported: ` +
            HOST_TYPES.map((t) => `<${t}>`).join(', ') +
            (custom.length > 0
              ? `; registered: ${custom.map((t) => `<${t}>`).join(', ')}`
              : '') +
            '. Third-party elements are added with registerElement() from ' +
            'react-x11/host (docs/extending.md).',
        );
      }
    }
    node._reactFiber = internalHandle;
    return node;
  },

  createTextInstance(text, rootContainer, hostContext) {
    if (!hostContext.isInsideText && !hostContext.isInsideSvg) {
      throw new Error(
        `react-x11: raw text ${JSON.stringify(text)} must be wrapped in a ` +
          '<text> element (or be the string child of an SVG <text>).',
      );
    }
    return new TextChunkNode(text, rootContainer);
  },

  appendInitialChild(parentInstance, child) {
    parentInstance.insertBefore(child, null);
  },

  finalizeInitialChildren(instance, type, props) {
    // Popups are not attached to the container or realized by a parent
    // window; commitMount realizes them against the screen root. autoFocus
    // and trapFocus need commitMount too — the node has to be in the tree
    // first, so it can find the EventManager that owns focus. Drop targets
    // likewise: registration needs the root, which insertion assigns.
    //
    // Under REACT_X11_STRICT_TOKENS every token-styled node asks for one as
    // well, since a bad token is only *found* once the node is attached —
    // which is after this ran — and commitMount is the first moment React
    // holds that node's own fiber (nodes.js `_tokenProblem`). Gated on the
    // flag so the default mount pays nothing for a debugging mode.
    return (
      type === 'popup' ||
      Boolean(props.autoFocus) ||
      Boolean(props.trapFocus) ||
      hasDropProps(props) ||
      (STRICT_TOKENS && instance._usesTokens)
    );
  },

  commitMount(instance, type, props) {
    // first, and before any of the work below: the tree is on its way out.
    // `false` afterwards marks this instance's one commitMount spent, so a
    // later re-attach throws at once rather than deferring to a call that
    // will never come (nodes.js `_tokenProblem`).
    const tokenError = instance._tokenError;
    instance._tokenError = false;
    if (tokenError) throw tokenError;
    if (type === 'popup') {
      instance.realize(null);
    }
    if (props.trapFocus) {
      instance._syncFocusScope?.();
    }
    if (hasDropProps(props)) {
      instance.root?._registerDropTarget?.(instance);
    }
    if (props.autoFocus && typeof instance.focus === 'function') {
      instance.focus();
    }
  },

  appendChild(parentInstance, child) {
    parentInstance.insertBefore(child, null);
  },

  appendChildToContainer(container, child) {
    if (!child.window) {
      // Top-level window: realize the whole subtree top-down against the
      // screen root.
      child.realize(null);
    }
    // React's getPublicRootInstance answers from the root fiber's first
    // child, and only when that child is a host component. `render()` wraps
    // the tree in a context provider, which is not one, so it would answer
    // null — the container keeps the list instead. Same answer as before:
    // the first top-level node the tree put here.
    (container._rootChildren ??= []).push(child);
    a11yHooks.rootMounted?.(child);
  },

  insertBefore(parentInstance, child, beforeChild) {
    parentInstance.insertBefore(child, beforeChild);
  },

  insertInContainerBefore(container, child) {
    HostConfig.appendChildToContainer(container, child);
  },

  removeChild(parentInstance, child) {
    parentInstance.removeChild(child);
  },

  removeChildFromContainer(container, child) {
    const roots = container._rootChildren;
    const at = roots ? roots.indexOf(child) : -1;
    if (at !== -1) roots.splice(at, 1);
    // before the destroy, while the subtree is still walkable
    a11yHooks.rootUnmounted?.(child);
    child.destroySubtree();
  },

  clearContainer() {},

  commitUpdate(instance, type, oldProps, newProps) {
    instance.applyProps(newProps, oldProps);
  },

  shouldSetTextContent() {
    return false;
  },

  commitTextUpdate(textInstance, oldText, newText) {
    textInstance.setText(newText);
  },

  resetTextContent() {},

  hideInstance(instance) {
    instance.setHidden(true);
  },

  unhideInstance(instance) {
    instance.setHidden(false);
  },

  hideTextInstance(textInstance) {
    textInstance.setText('');
  },

  unhideTextInstance(textInstance, text) {
    textInstance.setText(text);
  },

  detachDeletedInstance(instance) {
    instance.root?.events?.forget(instance);
    instance.root?._forgetDropTarget?.(instance);
  },

  preparePortalMount() {},
  prepareScopeUpdate() {},
  getInstanceFromScope() {
    return null;
  },
  getInstanceFromNode() {
    return null;
  },
  beforeActiveInstanceBlur() {},
  afterActiveInstanceBlur() {},

  // Update priority plumbing (React 19 scheduling contract).
  setCurrentUpdatePriority,
  getCurrentUpdatePriority,
  resolveUpdatePriority,
  shouldAttemptEagerTransition() {
    return false;
  },
  trackSchedulerEvent() {},
  resolveEventType() {
    return null;
  },
  resolveEventTimeStamp() {
    return -1.1;
  },
  requestPostPaintCallback() {},

  // Suspensey commits are not used by this renderer.
  maySuspendCommit() {
    return false;
  },
  maySuspendCommitOnUpdate() {
    return false;
  },
  maySuspendCommitInSyncRender() {
    return false;
  },
  preloadInstance() {
    return true;
  },
  startSuspendingCommit() {},
  suspendInstance() {},
  waitForCommitToBeReady() {
    return null;
  },

  // Form actions / transitions (unused, required by the contract).
  NotPendingTransition: null,
  HostTransitionContext: React.createContext(null),
  resetFormInstance() {},

  bindToConsole(methodName, args) {
    return Function.prototype.bind.apply(console[methodName], [
      console,
      ...args,
    ]);
  },
};

export const Renderer = ReactReconciler(HostConfig);

// So the event dispatcher can land a discrete-priority commit before it
// paints the response to that same input — see flushSyncWork in priority.js.
setSyncFlush(() => Renderer.flushSyncWork());

let integrations = null;
let integrationsSettled = false;

/**
 * The opt-in integrations, each behind its environment variable and each
 * dynamically imported so a bundle only carries what it is asked for.
 *
 * This runs from `render()`/`createRoot()` rather than at module scope: a
 * top-level await here would be inherited by every bundle containing
 * react-x11, and esbuild cannot emit CommonJS for a graph that has one —
 * which is what a Node single executable needs (see docs/packaging.md).
 * The ordering guarantee is unchanged, because a React commit can only
 * follow a root, and there is no way to obtain one without going through
 * here first.
 *
 * Returns `null` when there is nothing to install — which is the normal
 * case, and keeps `render(element, callback, container)` synchronous, as
 * callers that read the tree straight after it expect.
 */
function loadIntegrations() {
  if (integrationsSettled) return null;
  if (
    !process.env.REACT_X11_DEVTOOLS &&
    !process.env.REACT_X11_CLICK_TO_COMPONENT &&
    !process.env.REACT_X11_EDITOR &&
    !process.env.REACT_X11_TRACE
  ) {
    return null;
  }
  if (integrations) return integrations;
  integrations = (async () => {
    if (process.env.REACT_X11_DEVTOOLS) {
      // Install the DevTools hook before any React commit, and register the
      // renderer with the standalone DevTools app.
      const devtools = await import('./DevToolsIntegration.js');
      await devtools.prepare();
      devtools.connect(Renderer);
    }

    if (
      process.env.REACT_X11_CLICK_TO_COMPONENT ||
      process.env.REACT_X11_EDITOR
    ) {
      // Naming an editor already means you want the feature on — no need to
      // also set REACT_X11_CLICK_TO_COMPONENT=1 just to pick one.
      const clickToComponent = await import('./ClickToComponent.js');
      clickToComponent.install();
    }

    if (process.env.REACT_X11_TRACE) {
      // Protocol tracing (docs/debugging.md). debug.js writes files, which
      // the playground bundle must not drag in. The trace itself attaches
      // per connection, as each root registers the app it connected (or
      // borrowed).
      const debug = await import('./debug.js');
      debug.startEnvTrace(process.env.REACT_X11_TRACE);
    }
    integrationsSettled = true;
  })();
  return integrations;
}

/**
 * Open a connection this process owns. The wrapper is here for one reason:
 * to say what is wrong when there is no server, which is the first thing
 * anyone hits and the least self-explanatory failure in the library.
 */
async function connect(options) {
  try {
    return await createClient(options);
  } catch (err) {
    const display = options.display ?? process.env.DISPLAY ?? '<unset>';
    throw new Error(
      'react-x11: could not connect to the X server. Is an X server running ' +
        `and DISPLAY set (DISPLAY=${display})? Original error: ` +
        err.message,
      { cause: err },
    );
  }
}

/** An ntk App, told apart from an options bag by what only an App has. */
const isNtkApp = (v) =>
  Boolean(v) && typeof v.createWindow === 'function' && typeof v.X === 'object';

// What a root that opens its own connection forwards to ntk. `stream` is
// how you reach a server that is not on the other end of $DISPLAY — an
// in-process one, a tunnel — and is what the tests connect through.
const CONNECT_OPTIONS = [
  'display',
  'stream',
  'fontSource',
  'glxVisual',
  // which OpenGL backend <glarea> draws through: 'indirect' (ntk's
  // default), 'auto', 'direct' or 'off'. It has to be passed at connect time
  // rather than set later, because ntk probes for the direct backend during
  // the handshake — see docs/gl.md.
  'glPolicy',
  'onXError',
];

const DEFAULT_ERROR_HANDLERS = defaultRootHandlers;

/**
 * The connection ended without us asking. `end` is the stream closing —
 * server exit, ssh drop, kill. An `error` may be either a transport failure
 * or an X protocol error ntk already reports through `onXError`; only the
 * former ends the connection, and only it carries no `majorOpcode`.
 */
function watchConnection(app, onDisconnect, deliberate) {
  let done = false;
  const fire = (reason, err) => {
    if (done || deliberate()) return;
    done = true;
    onDisconnect(reason, err);
  };
  app.X.on('end', () => fire('closed'));
  app.X.on('error', (err) => {
    if (err?.majorOpcode === undefined) fire('error', err);
  });
}

/**
 * The entry point:
 *
 *   const root = await createRoot();                 // connects via $DISPLAY
 *   const root = await createRoot({ display: ':1' });
 *   const root = await createRoot({ app });          // a connection you have
 *   root.render(<App />);
 *   await root.unmount();
 *
 * Every root without `app` opens **its own** connection and owns it, so two
 * roots are two independent trees; `unmount()` closes what it opened. A root
 * given an `app` borrows it and never closes it — that connection belongs to
 * whoever made it.
 *
 * `display`, `fontSource`, `glxVisual` and `onXError` go straight to ntk.
 * Anything else ntk understands, build the client yourself and pass `app`.
 *
 * `desktop: false` turns off the three things this turns on for you that talk
 * to the session bus — the appearance ladder, the accessibility bridge and
 * the global menu — for an embedder that owns them, or a process that must
 * not fork. `desktop: { appearance: false }` names one. See
 * src/desktopintegration.js and docs/desktop.md.
 */
export async function createRoot(options = {}) {
  // Before anything builds a node: every drawn node creates a yoga node in
  // its constructor, and the engine's WebAssembly is loaded rather than
  // imported (src/yoga.js — a top-level await here would cost every app the
  // single-executable build). ntk's createClient used to do this while the
  // engine was still ntk's, which also covered `createRoot({ app })`; it is
  // ours now, so this is the one place that has to know. It runs alongside the
  // connection rather than before it — neither needs the other — though "I/O"
  // flatters the engine: most of that load is the loop-blocking instantiate,
  // which is why the order below is what it is.
  //
  // The misuse check comes before anything starts, so a bad call cannot leave
  // a load or a connection in flight with nothing waiting on it.
  if (isNtkApp(options)) {
    throw new Error(
      'react-x11: createRoot takes an options object — pass the connection ' +
        'as createRoot({ app }).',
    );
  }
  const { app: borrowed, onDisconnect, ...rest } = options;
  const owned = borrowed === undefined;
  // Before anything starts, for two reasons: a bad `desktop` shape must throw
  // with nothing in flight, like the check above it — and `startA11y()` below
  // reads this policy, so it has to be settled before the first await, not
  // after (src/desktopintegration.js).
  setDesktopIntegration(rest.desktop);
  // The connection is started first, and the order is the point rather than a
  // detail. `loadLayout()` is only nominally asynchronous: instantiating the
  // engine blocks the event loop for 15-50 ms before it returns its promise
  // (measured), so calling it first delays the socket work by exactly that —
  // the loop cannot run the connect callback that writes the hello while the
  // instantiate is on it. Starting the connection first puts the handshake in
  // flight, and the block then overlaps it instead of preceding it.
  //
  // Worth being honest about the size: the most this can save is the
  // synchronous block, and only where the handshake takes longer than it. It
  // is not measurable on a Unix socket, and it is lost in the noise on a link
  // slow enough to matter. This is the right order, not a fast one.
  const connecting = owned
    ? connect(
        Object.fromEntries(
          CONNECT_OPTIONS.filter((k) => rest[k] !== undefined).map((k) => [
            k,
            rest[k],
          ]),
        ),
      )
    : Promise.resolve(borrowed);
  const layout = loadLayout();
  const integrations = loadIntegrations(); // null when there is nothing to install
  const [app] = await Promise.all([connecting, layout, integrations]);

  const container = Renderer.createContainer(
    app,
    ConcurrentRoot,
    null,
    false,
    null,
    '',
    rest.onUncaughtError ?? DEFAULT_ERROR_HANDLERS.onUncaughtError,
    rest.onCaughtError ?? DEFAULT_ERROR_HANDLERS.onCaughtError,
    rest.onRecoverableError ?? DEFAULT_ERROR_HANDLERS.onRecoverableError,
    null,
  );

  // A throw from an event handler has no React on the stack, so it never
  // reaches the container above — the root's handler is reached through the
  // container instead, which is what the nodes carry.
  if (rest.onUncaughtError) setErrorHandler(app, rest.onUncaughtError);

  let unmounted = false;
  if (onDisconnect) watchConnection(app, onDisconnect, () => unmounted);

  // borrowed or owned, this is now a connection the renderer draws through,
  // which is what a REACT_X11_TRACE / startTrace() session follows
  registerApp(app);

  // Climb toward the accessibility bus, once per process and off the
  // critical path — every rung that fails is a normal, silent "off"
  // (docs/accessibility.md). Deliberately not awaited: a root must not
  // wait on a bus that is not there.
  startA11y();

  // Before anything renders: the launch id has to be on the first toplevel
  // before it maps, and the environment variable has to be consumed whether
  // or not this app ends up using it (src/startup.js).
  beginStartup(app, rest.startupNotification);

  // Which dead-key and Compose sequences this root types (src/compose.js).
  // Synchronous and normally free: the built-in table is built once per
  // process, and only `compose: 'system'` or a file of your own reads
  // anything from disk.
  beginCompose(app, rest.compose);

  // Whether a subtree coming back out of hiding — a `<Suspense>` boundary
  // resolving, an `<Activity>` shown again — takes the keyboard back with it
  // (src/events.js, `subtreeRevealed`). On by default; `false` is the
  // browser's answer, where focus stays wherever the hide dropped it.
  beginFocus(app, rest.restoreFocusOnReveal);

  // Which keysym a shortcut matches when the layout is not Latin
  // (src/keyboard.js). Pure bookkeeping — the work happens per key event,
  // and only for a key that types another script.
  beginKeyboard(app, rest.accelerators);

  // Awaited, and this is the only place it can be: whether a compositor is
  // running decides what a `transparent` window paints, and a window that
  // realized before the answer landed would paint the wrong thing once and
  // correct itself visibly — and the same shape of question twice more. The
  // display scale multiplies every style length, every font size and every
  // CreateWindow rectangle, so it must be settled before the first node
  // resolves a style — there is no "correct it a frame later" for a tree
  // that laid out at half size; normally free or one round trip (the
  // environment answers, or XSETTINGS does), with the RandR hardware walk
  // only paid on desktops where nothing cheaper answered (src/scale.js).
  // And a `<window>` with no size given is sized from its content and
  // capped at the screen, where the cap has to be a *synchronous* answer
  // because the size is resolved before CreateWindow. The three probes are
  // independent conversations with the server (a selection owner and an
  // extension; the scale ladder; the monitor layout and the work-area
  // property), so they run concurrently: each is internally a chain of one
  // to three round trips, and awaiting them in sequence made every app pay
  // the sum where the slowest chain is the true floor.
  await Promise.all([
    beginCompositing(app),
    beginScale(app, rest.scale),
    beginScreens(app),
  ]);

  // How fast a caret blinks, how long a double click has, how far a press
  // moves before it is a drag. **Not** awaited, unlike the two above: the
  // renderer reads these synchronously but only on an interaction — a focus,
  // a click, a drag — which is always many milliseconds after startup, so
  // making every app wait five round trips for them would buy nothing. A
  // field focused on the very first frame gets the built-in defaults and the
  // desktop's cadence from its next focus on (src/desktopsettings.js).
  beginDesktopSettings(app);

  // The desktop switching between light and dark reaches the widgets through
  // React — `useTheme()` subscribes — but the other theme route is the node
  // tree, which React does not re-render. This is that half: drop the cached
  // palettes and repaint, above all the window background, which is read from
  // the palette at paint time. Not awaited, and it starts nothing: the store
  // is seeded from disk and the ladder runs when something asks.
  const stopAppearance = watchAppearance(() => appearanceChanged(app));

  const root = {
    app,
    render(element, callback) {
      // The provider wraps rather than replaces: it renders no host node, so
      // `getPublicRootInstance` still hands back the tree's own root and
      // nothing downstream can tell it is there. `null` unmounts, and must
      // stay null rather than become a provider around nothing.
      // The provider renders no host node, so it changes nothing about
      // what is drawn — but it does sit between the root fiber and the
      // tree, which is why the public instance comes from the container's
      // own record rather than from getPublicRootInstance. `null` unmounts,
      // and has to stay null rather than become a provider around nothing.
      const tree =
        element == null
          ? element
          : React.createElement(AppProvider, { value: app }, element);
      Renderer.updateContainerSync(tree, container, null, () => {
        const rootNode = app._rootChildren?.[0] ?? null;
        callback?.(rootNode && HostConfig.getPublicInstance(rootNode), app);
      });
      Renderer.flushSyncWork();
    },
    /** Unmounts, then closes the connection unless `app` was passed in. */
    async unmount() {
      if (unmounted) return;
      unmounted = true;
      Renderer.updateContainerSync(null, container, null, null);
      Renderer.flushSyncWork();
      if (rest.onUncaughtError) setErrorHandler(app, null);
      stopAppearance();
      endCompositing(app);
      endScreens(app);
      endDesktopSettings(app);
      endIdle(app);
      endKeyboardState(app);
      // The XSETTINGS session outlives both of its readers otherwise: it
      // holds a PropertyChange selection on the settings daemon's window and
      // an XFixes watch on the selection, neither of which anything else
      // takes off.
      endXSettings(app);
      if (owned) {
        unregisterApp(app);
        await app.close();
      }
      if (app._reactX11Root === root) app._reactX11Root = null;
    },
  };

  // What a WM close request with no onCloseRequest unmounts (see
  // WindowNode#_defaultCloseRequest). The first root wins, because it is the
  // one whose window the request will be arriving on; a second root sharing a
  // borrowed connection owns its own teardown either way.
  app._reactX11Root ??= root;

  return root;
}

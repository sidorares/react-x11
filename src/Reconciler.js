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
import { defaultRootHandlers, setErrorHandler } from './errors.js';
import {
  registerApp,
  unregisterApp,
  hooks as traceHooks,
} from './trace-registry.js';
import { hooks as a11yHooks, startA11y } from './a11y.js';
import { beginStartup } from './startup.js';
import { beginCompose } from './compose.js';
import { beginKeyboard } from './keyboard.js';
import { beginCompositing, endCompositing } from './compositing.js';
import { beginScreens, endScreens } from './screens.js';
import { watchAppearance } from './appearance.js';
import { ForeignNode } from './foreignnodes.js';
import { GlAreaNode } from './glnodes.js';
import { directGLFailure, hasDirectGL } from './glbackend.js';
import { createRegisteredNode, registeredElements } from './registry.js';
import {
  DIRECT_ONLY_KINDS,
  SCENE_KINDS,
  UNSUPPORTED_KINDS,
  createSceneNode,
} from './scene3d.js';
import {
  MarkdownNode,
  HtmlNode,
  SvgNode,
  SvgChildNode,
  TexNode,
} from './richnodes.js';

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
  'markdown',
  'html',
  'svg',
  'tex',
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
      isInsideRichText: false,
      isInside3d: false,
    };
  },

  getChildHostContext(parentHostContext, type) {
    return {
      isInsideText: parentHostContext.isInsideText || type === 'text',
      // <svg> children are declarative SVG elements, not react-x11 nodes
      isInsideSvg: parentHostContext.isInsideSvg || type === 'svg',
      // <markdown>/<html>/<tex> take their content as a string child
      // (react-markdown style); no elements are allowed inside
      isInsideRichText:
        type === 'markdown' || type === 'html' || type === 'tex',
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
    if (hostContext.isInsideRichText) {
      throw new Error(
        `react-x11: <${type}> is not allowed inside <markdown>/<html>/<tex>; ` +
          'their content is a string child (or the source prop).',
      );
    }
    if (hostContext.isInsideText && type !== 'text') {
      throw new Error(
        `react-x11: <${type}> is not allowed inside <text>; only nested ` +
          '<text> spans and strings are.',
      );
    }
    if (hostContext.isInside3d) {
      // A shader material needs a pipeline that has shaders. Whether this
      // connection has one is already known — ntk settles it during connect —
      // so the answer arrives here rather than as a blank surface later.
      if (DIRECT_ONLY_KINDS[type] && !hasDirectGL(rootContainer)) {
        // Say which of the several reasons it is. ntk worked it out during
        // the connection handshake, and they call for different fixes — an
        // addon to install, a display that cannot carry descriptors, a server
        // without DRI3, or simply a policy left at its default.
        const reason = directGLFailure(rootContainer);
        const why = reason
          ? `\n\n${reason.code}: ${reason.message}` +
            (reason.hint ? `\n\n${reason.hint}` : '')
          : '\n\nThe direct-rendering probe has not run on this connection. It runs ' +
            'during createRoot() when glPolicy could select the direct backend, and ' +
            'the default policy is "indirect":\n\n' +
            "  const root = await createRoot({ glPolicy: 'auto' });";
        const err = new Error(
          `react-x11: <${type}> needs direct rendering — ${DIRECT_ONLY_KINDS[type]} — ` +
            `and this connection does not have it.${why}\n\n` +
            "useSupports('shaders') is the check to branch on if this scene should " +
            'degrade rather than fail. See docs/gl.md.',
        );
        err.code = reason?.code ?? 'GL_NO_DIRECT';
        throw err;
      }
      const scene = createSceneNode(type, props, rootContainer);
      if (scene) {
        scene._reactFiber = internalHandle;
        return scene;
      }
      if (UNSUPPORTED_KINDS[type]) {
        throw new Error(
          `react-x11: <${type}> is not supported — ` +
            `${UNSUPPORTED_KINDS[type]}. See docs/gl.md.`,
        );
      }
      throw new Error(
        `react-x11: <${type}> is not a 3D element; inside <glarea> only ` +
          [...SCENE_KINDS].map((t) => `<${t}>`).join(', ') +
          ' are.',
      );
    }
    let node;
    switch (type) {
      case 'window':
        // No X11 calls here: the render phase may be discarded. The real
        // window is created top-down in the commit phase (realize).
        node = new WindowNode(rootContainer, windowAttributes(props), props);
        break;
      case 'popup':
        node = new PopupNode(rootContainer, windowAttributes(props), props);
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
      case 'markdown':
        node = new MarkdownNode(props, rootContainer);
        break;
      case 'html':
        node = new HtmlNode(props, rootContainer);
        break;
      case 'svg':
        node = new SvgNode(props, rootContainer);
        break;
      case 'tex':
        node = new TexNode(props, rootContainer);
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
        if (SCENE_KINDS.has(type) || UNSUPPORTED_KINDS[type]) {
          throw new Error(
            `react-x11: <${type}> is a 3D element and only works inside ` +
              '<glarea> (or the <Canvas3D> component).',
          );
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
    if (
      !hostContext.isInsideText &&
      !hostContext.isInsideRichText &&
      !hostContext.isInsideSvg
    ) {
      throw new Error(
        `react-x11: raw text ${JSON.stringify(text)} must be wrapped in a ` +
          '<text> element (or be the string child of <markdown>/<html>/' +
          '<tex>/an SVG <text>).',
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
    return (
      type === 'popup' ||
      Boolean(props.autoFocus) ||
      Boolean(props.trapFocus) ||
      hasDropProps(props)
    );
  },

  commitMount(instance, type, props) {
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
  // which OpenGL backend <glarea>/<Canvas3D> draw through: 'indirect' (ntk's
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
 */
export async function createRoot(options = {}) {
  await loadIntegrations(); // null when there is nothing to install
  if (isNtkApp(options)) {
    throw new Error(
      'react-x11: createRoot takes an options object — pass the connection ' +
        'as createRoot({ app }).',
    );
  }
  const { app: borrowed, onDisconnect, ...rest } = options;
  const owned = borrowed === undefined;
  const app = owned
    ? await connect(
        Object.fromEntries(
          CONNECT_OPTIONS.filter((k) => rest[k] !== undefined).map((k) => [
            k,
            rest[k],
          ]),
        ),
      )
    : borrowed;

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

  // Which keysym a shortcut matches when the layout is not Latin
  // (src/keyboard.js). Pure bookkeeping — the work happens per key event,
  // and only for a key that types another script.
  beginKeyboard(app, rest.accelerators);

  // Awaited, and this is the only place it can be: whether a compositor is
  // running decides what a `transparent` window paints, and a window that
  // realized before the answer landed would paint the wrong thing once and
  // correct itself visibly. One round trip, on a path that is already async.
  await beginCompositing(app);

  // Awaited for the same reason, and it is the same shape of question: a
  // `<window>` with no size given is sized from its content and capped at the
  // screen, and the cap has to be a *synchronous* answer because the size is
  // resolved before CreateWindow. One round trip for the monitor layout and
  // one for the work area, on a path that is already async, and after this
  // no window ever has to wait to know how big it is allowed to be.
  await beginScreens(app);

  // The desktop switching between light and dark reaches the widgets through
  // React — `useTheme()` subscribes — but the other theme route is the node
  // tree, which React does not re-render. This is that half: drop the cached
  // palettes and repaint, above all the window background, which is read from
  // the palette at paint time. Not awaited, and it starts nothing: the store
  // is seeded from disk and the ladder runs when something asks.
  const stopAppearance = watchAppearance(() => appearanceChanged(app));

  return {
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
      if (owned) {
        unregisterApp(app);
        await app.close();
      }
    },
  };
}

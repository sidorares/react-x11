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
} from './priority.js';
import {
  WindowNode,
  PopupNode,
  BoxNode,
  TextNode,
  TextChunkNode,
  ImageNode,
  CanvasNode,
  ScrollViewNode,
  TextInputNode,
  TextAreaNode,
  flushWindowRestacks,
  WINDOW_HINT_PROPS,
} from './nodes.js';
import { flattenStyle } from './styles.js';
import { GlAreaNode } from './glnodes.js';
import { SCENE_KINDS, UNSUPPORTED_KINDS, createSceneNode } from './scene3d.js';
import {
  MarkdownNode,
  HtmlNode,
  SvgNode,
  SvgChildNode,
  TexNode,
} from './richnodes.js';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json');

const HOST_TYPES = [
  'window',
  'popup',
  'box',
  'text',
  'image',
  'canvas',
  'scrollview',
  'textinput',
  'textarea',
  'markdown',
  'html',
  'svg',
  'tex',
  'glarea',
];

const isEventProp = (name) => /^on[A-Z]/.test(name);

// Props forwarded to ntk createWindow. Event handlers are dispatched by the
// EventManager from current props (never registered at creation, so they
// cannot go stale) and children are handled by the tree.
/**
 * ntk's Window constructor takes every creation attribute up front. The
 * user-facing shape and ntk's differ in two places: size hints are flat
 * props here and a `sizeHints` object there, and the window background is
 * a style property here and a creation attribute there.
 */
function windowAttributes(props) {
  const attributes = {};
  const hints = {};
  for (const key of Object.keys(props)) {
    if (key === 'children' || key === 'style' || isEventProp(key)) continue;
    if (WINDOW_HINT_PROPS.includes(key)) {
      hints[key] = props[key];
      continue;
    }
    attributes[key] = props[key];
  }
  if (Object.keys(hints).length > 0) attributes.sizeHints = hints;
  if (props.style !== undefined) {
    const style = flattenStyle(props.style);
    if (style.backgroundColor !== undefined) {
      attributes.backgroundColor = style.backgroundColor;
    }
  }
  return attributes;
}

const HostConfig = {
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  supportsResources: false,
  supportsSingletons: false,
  supportsTestSelectors: false,
  supportsMicrotasks: true,
  isPrimaryRenderer: true,
  warnsIfNotActing: false,

  // What DevTools shows for this renderer. These are the whole story in
  // react-reconciler 0.33: `injectIntoDevTools()` takes no arguments and
  // reads them from here.
  rendererVersion: packageJson.version,
  rendererPackageName: packageJson.name,
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
    return null;
  },

  // child <window>s that moved in the tree restack here, so a reorder costs
  // one pass instead of one per insertBefore
  resetAfterCommit() {
    flushWindowRestacks();
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
      const scene = createSceneNode(type, props, rootContainer);
      if (scene) {
        scene._reactFiber = internalHandle;
        return scene;
      }
      if (UNSUPPORTED_KINDS[type]) {
        throw new Error(
          `react-x11: <${type}> cannot work over indirect GLX — ` +
            `${UNSUPPORTED_KINDS[type]}. See docs/glx-plan.md.`,
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
      case 'scrollview':
        node = new ScrollViewNode(props, rootContainer);
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
      default:
        if (SCENE_KINDS.has(type) || UNSUPPORTED_KINDS[type]) {
          throw new Error(
            `react-x11: <${type}> is a 3D element and only works inside ` +
              '<glarea> (or the <Canvas3D> component).',
          );
        }
        throw new Error(
          `react-x11: unknown element type <${type}>. Supported: ` +
            HOST_TYPES.map((t) => `<${t}>`).join(', ') +
            '.',
        );
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
    // first, so it can find the EventManager that owns focus.
    return (
      type === 'popup' || Boolean(props.autoFocus) || Boolean(props.trapFocus)
    );
  },

  commitMount(instance, type, props) {
    if (type === 'popup') {
      instance.realize(null);
    }
    if (props.trapFocus) {
      instance._syncFocusScope?.();
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

if (process.env.REACT_X11_DEVTOOLS) {
  // Install the DevTools hook before any React commit (top-level await:
  // module evaluation finishes before app code can call render) and
  // register the renderer with the standalone DevTools app.
  const devtools = await import('./DevToolsIntegration.js');
  await devtools.prepare();
  devtools.connect(Renderer);
}

if (process.env.REACT_X11_CLICK_TO_COMPONENT || process.env.REACT_X11_EDITOR) {
  // Naming an editor already means you want the feature on — no need to
  // also set REACT_X11_CLICK_TO_COMPONENT=1 just to pick one.
  const clickToComponent = await import('./ClickToComponent.js');
  clickToComponent.install();
}

const roots = new Map();
let cachedNtkApp = null;

async function connectApp() {
  if (cachedNtkApp) return cachedNtkApp;
  try {
    cachedNtkApp = await createClient();
  } catch (err) {
    throw new Error(
      'react-x11: could not connect to the X server. Is an X server running ' +
        `and DISPLAY set (DISPLAY=${process.env.DISPLAY || '<unset>'})? ` +
        'Original error: ' +
        err.message,
    );
  }
  return cachedNtkApp;
}

function renderIntoContainer(element, container, callback) {
  let root = roots.get(container);
  if (!root) {
    root = Renderer.createContainer(
      container,
      ConcurrentRoot,
      null,
      false,
      null,
      '',
      (error) => console.error('react-x11: uncaught error', error),
      (error) => console.error('react-x11: caught error', error),
      (error) => console.error('react-x11: recoverable error', error),
      null,
    );
    roots.set(container, root);
  }

  Renderer.updateContainerSync(element, root, null, () => {
    const publicInstance = Renderer.getPublicRootInstance(root);
    if (callback) {
      callback(publicInstance, container);
    }
  });
  Renderer.flushSyncWork();
}

/**
 * Legacy entry point. Without a container it connects to the X server
 * (returns a promise in that case).
 */
export function render(element, callback, container) {
  if (!container) {
    return connectApp().then((app) =>
      renderIntoContainer(element, app, callback),
    );
  }
  return renderIntoContainer(element, container, callback);
}

/**
 * Modern entry point:
 *
 *   const root = await createRoot();       // connects via DISPLAY
 *   root.render(<App />);
 *
 * Pass an ntk App (or a mock) to render into an existing connection.
 */
export async function createRoot(container) {
  const app = container ?? (await connectApp());
  return {
    app,
    render(element, callback) {
      renderIntoContainer(element, app, callback);
    },
    unmount() {
      unmountComponentAtNode(app);
    },
  };
}

export function unmountComponentAtNode(container) {
  const root = roots.get(container);
  if (root) {
    Renderer.updateContainerSync(null, root, null, () => {
      roots.delete(container);
    });
    Renderer.flushSyncWork();
  }
}

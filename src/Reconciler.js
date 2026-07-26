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
} from './nodes.js';

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
];

const isEventProp = (name) => /^on[A-Z]/.test(name);

// Props forwarded to ntk createWindow. Event handlers are dispatched by the
// EventManager from current props (never registered at creation, so they
// cannot go stale) and children are handled by the tree.
function windowAttributes(props) {
  const attributes = {};
  for (const key of Object.keys(props)) {
    if (key === 'children' || isEventProp(key)) continue;
    attributes[key] = props[key];
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

  rendererVersion: packageJson.version,
  rendererPackageName: packageJson.name,
  extraDevToolsConfig: null,

  scheduleTimeout: setTimeout,
  cancelTimeout: clearTimeout,
  noTimeout: -1,
  scheduleMicrotask: queueMicrotask,

  getRootHostContext() {
    return { isInsideText: false };
  },

  getChildHostContext(parentHostContext, type) {
    return {
      isInsideText: parentHostContext.isInsideText || type === 'text',
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

  resetAfterCommit() {},

  createInstance(type, props, rootContainer, hostContext, internalHandle) {
    if (hostContext.isInsideText && type !== 'text') {
      throw new Error(
        `react-x11: <${type}> is not allowed inside <text>; only nested ` +
          '<text> spans and strings are.',
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
      default:
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
    if (!hostContext.isInsideText) {
      throw new Error(
        `react-x11: raw text ${JSON.stringify(text)} must be wrapped in a ` +
          '<text> element.',
      );
    }
    return new TextChunkNode(text, rootContainer);
  },

  appendInitialChild(parentInstance, child) {
    parentInstance.insertBefore(child, null);
  },

  finalizeInitialChildren(instance, type) {
    // Popups are not attached to the container or realized by a parent
    // window; commitMount realizes them against the screen root.
    return type === 'popup';
  },

  commitMount(instance, type) {
    if (type === 'popup') {
      instance.realize(null);
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

const React = require('react');
const ReactReconciler = require('react-reconciler');
const {
  ConcurrentRoot,
  DefaultEventPriority,
  NoEventPriority,
} = require('react-reconciler/constants');

const packageJson = require('../package.json');

// Props that configure the X11 window itself; everything else (event
// handlers, children, refs) is handled elsewhere.
const isEventProp = (name) => /^on[A-Z]/.test(name);

function windowAttributes(props) {
  const attributes = {};
  for (const key of Object.keys(props)) {
    if (key === 'children') continue;
    attributes[key] = props[key];
  }
  return attributes;
}

let currentUpdatePriority = NoEventPriority;

// Host instances are lightweight handles, not X11 windows. React creates
// instances bottom-up (completeWork) during the render phase, where the
// parent window cannot exist yet and where concurrent rendering may still
// discard the work. The real CreateWindow calls happen top-down in the
// commit phase (see realize), so every window names its actual parent from
// the start — no ReparentWindow, no override-redirect staging (issue #4).
function createHandle(props, rootContainer, fiber) {
  return {
    props,
    container: rootContainer,
    fiber,
    children: [],
    window: null,
  };
}

function realize(handle, parentWindow) {
  const attributes = windowAttributes(handle.props);
  if (parentWindow) {
    attributes.parent = parentWindow;
  }
  const wnd = handle.container.createWindow(attributes);
  wnd._reactFiber = handle.fiber;
  handle.window = wnd;
  for (const child of handle.children) {
    realize(child, wnd);
  }
  // Children map before their parent, so the subtree appears at once when
  // the outermost window maps.
  wnd.map();
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
    return {};
  },

  getChildHostContext(parentHostContext) {
    return parentHostContext;
  },

  getPublicInstance(instance) {
    // Refs attach in the layout phase, after the mutation phase realized
    // the window, so this is always the live ntk window.
    return instance.window || instance;
  },

  prepareForCommit() {
    return null;
  },

  resetAfterCommit() {},

  createInstance(type, props, rootContainer, hostContext, internalHandle) {
    if (type !== 'window') {
      throw new Error(
        `react-x11: unknown element type <${type}>. Only <window> is supported for now.`,
      );
    }
    // No X11 calls here: this runs in the render phase, which concurrent
    // React may discard. The window is created in the commit phase.
    return createHandle(props, rootContainer, internalHandle);
  },

  appendInitialChild(parentInstance, child) {
    parentInstance.children.push(child);
  },

  finalizeInitialChildren() {
    return false;
  },

  commitMount() {},

  appendChild(parentInstance, child) {
    const index = parentInstance.children.indexOf(child);
    if (index !== -1) {
      parentInstance.children.splice(index, 1);
    }
    parentInstance.children.push(child);
    if (!child.window) {
      realize(child, parentInstance.window);
    }
    // An already-realized child means a reorder among siblings; X11
    // stacking order is not modelled yet.
  },

  appendChildToContainer(container, child) {
    if (!child.window) {
      // Top-level window: realize the whole subtree top-down against the
      // screen root.
      realize(child, null);
    }
  },

  insertBefore(parentInstance, child) {
    // X11 stacking order is not modelled yet; treat as append.
    HostConfig.appendChild(parentInstance, child);
  },

  insertInContainerBefore(container, child) {
    HostConfig.appendChildToContainer(container, child);
  },

  removeChild(parentInstance, child) {
    const index = parentInstance.children.indexOf(child);
    if (index !== -1) {
      parentInstance.children.splice(index, 1);
    }
    if (child.window) {
      // DestroyWindow destroys all subwindows server-side as well.
      child.window.destroy();
      child.window = null;
    }
  },

  removeChildFromContainer(container, child) {
    if (child.window) {
      child.window.destroy();
      child.window = null;
    }
  },

  clearContainer() {},

  commitUpdate(instance, type, oldProps, newProps) {
    instance.props = newProps;
    const wnd = instance.window;
    if (type !== 'window' || !wnd) {
      return;
    }
    if (newProps.title !== oldProps.title) {
      wnd.setTitle(newProps.title || '');
    }
    if (
      newProps.width !== oldProps.width ||
      newProps.height !== oldProps.height
    ) {
      wnd.resize(newProps.width, newProps.height);
    }
    if (newProps.x !== oldProps.x || newProps.y !== oldProps.y) {
      wnd.move(newProps.x, newProps.y);
    }
    for (const key of Object.keys(newProps)) {
      if (isEventProp(key) && newProps[key] !== oldProps[key] && wnd.setProp) {
        wnd.setProp(key, newProps[key]);
      }
    }
  },

  shouldSetTextContent() {
    return false;
  },

  createTextInstance(text) {
    throw new Error(
      `react-x11: text nodes are not supported yet (got ${JSON.stringify(text)}). ` +
        'Wrap text handling in an expose/paint handler instead.',
    );
  },

  commitTextUpdate() {},
  resetTextContent() {},

  hideInstance(instance) {
    if (instance.window) {
      instance.window.unmap();
    }
  },

  unhideInstance(instance) {
    if (instance.window) {
      instance.window.map();
    }
  },

  hideTextInstance() {},
  unhideTextInstance() {},

  detachDeletedInstance(instance) {
    // Descendants of a destroyed window were destroyed server-side by
    // DestroyWindow; drop the JS-side reference.
    instance.window = null;
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
  setCurrentUpdatePriority(newPriority) {
    currentUpdatePriority = newPriority;
  },
  getCurrentUpdatePriority() {
    return currentUpdatePriority;
  },
  resolveUpdatePriority() {
    return currentUpdatePriority !== NoEventPriority
      ? currentUpdatePriority
      : DefaultEventPriority;
  },
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

const Renderer = ReactReconciler(HostConfig);

const roots = new Map();
let cachedNtkApp = null;

async function connectAndRender(element, callback) {
  // ntk is ESM (with top-level await in its graph), so it must be loaded with
  // a dynamic import from this CommonJS module.
  const { createClient } = await import('ntk');
  let app;
  try {
    app = await createClient();
  } catch (err) {
    throw new Error(
      'react-x11: could not connect to the X server. Is an X server running ' +
        `and DISPLAY set (DISPLAY=${process.env.DISPLAY || '<unset>'})? ` +
        'Original error: ' +
        err.message,
    );
  }
  cachedNtkApp = app;
  ReactX11.render(element, callback, app);
}

const ReactX11 = {
  render(element, callback, container) {
    if (!container) {
      if (cachedNtkApp) {
        return ReactX11.render(element, callback, cachedNtkApp);
      }
      // Returns a promise; an unawaited connection failure still surfaces as
      // an unhandled rejection with a descriptive message.
      return connectAndRender(element, callback);
    }

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

    if (process.env.REACT_X11_DEVTOOLS) {
      require('./DevToolsIntegration.js').connect(Renderer);
    }
  },

  unmountComponentAtNode(container) {
    const root = roots.get(container);
    if (root) {
      Renderer.updateContainerSync(null, root, null, () => {
        roots.delete(container);
      });
      Renderer.flushSyncWork();
    }
  },
};

module.exports = ReactX11;

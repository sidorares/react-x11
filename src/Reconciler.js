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

  getRootHostContext(rootContainer) {
    return {
      rootWindowId: rootContainer.X.display.screen[0].root,
    };
  },

  getChildHostContext(parentHostContext, type) {
    return { parent: parentHostContext, type };
  },

  getPublicInstance(instance) {
    return instance;
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
    const attributes = windowAttributes(props);
    // Windows that are not direct children of the root get reparented into
    // their parent window on commit; overrideRedirect keeps the window
    // manager from decorating them in the meantime.
    if (typeof hostContext.rootWindowId === 'undefined') {
      attributes.overrideRedirect = true;
    }
    const wnd = rootContainer.createWindow(attributes);
    if (!attributes.overrideRedirect) {
      wnd.map();
    }
    wnd._reactFiber = internalHandle;
    return wnd;
  },

  appendInitialChild(parentInstance, child) {
    if (parentInstance.__children) {
      parentInstance.__children.push(child);
    } else {
      parentInstance.__children = [child];
    }
  },

  finalizeInitialChildren() {
    // Return true so commitMount runs and reparents buffered children.
    return true;
  },

  commitMount(instance, type) {
    if (type !== 'window' || !instance.__children) {
      return;
    }
    for (const child of instance.__children) {
      if (child.reparentTo) {
        child.reparentTo(instance, child.x, child.y);
        child.map();
      }
    }
  },

  appendChild(parentInstance, child) {
    if (child.id && parentInstance.id && child.reparentTo) {
      child.reparentTo(parentInstance, child.x, child.y);
      child.map();
    }
    if (parentInstance.__children) {
      parentInstance.__children.push(child);
    } else {
      parentInstance.__children = [child];
    }
  },

  appendChildToContainer() {
    // Top-level windows are created directly on the X connection and mapped
    // in createInstance; nothing to attach to the container.
  },

  insertBefore(parentInstance, child) {
    // X11 stacking order is not modelled yet; treat as append.
    HostConfig.appendChild(parentInstance, child);
  },

  insertInContainerBefore() {},

  removeChild(parentInstance, child) {
    if (parentInstance.__children) {
      const index = parentInstance.__children.indexOf(child);
      if (index !== -1) {
        parentInstance.__children.splice(index, 1);
      }
    }
    if (child.destroy) {
      child.destroy();
    }
  },

  removeChildFromContainer(container, child) {
    if (child.destroy) {
      child.destroy();
    }
  },

  clearContainer() {},

  commitUpdate(instance, type, oldProps, newProps) {
    if (type !== 'window') {
      return;
    }
    if (newProps.title !== oldProps.title) {
      instance.setTitle(newProps.title || '');
    }
    if (
      newProps.width !== oldProps.width ||
      newProps.height !== oldProps.height
    ) {
      instance.resize(newProps.width, newProps.height);
    }
    if (newProps.x !== oldProps.x || newProps.y !== oldProps.y) {
      instance.move(newProps.x, newProps.y);
    }
    for (const key of Object.keys(newProps)) {
      if (
        isEventProp(key) &&
        newProps[key] !== oldProps[key] &&
        instance.setProp
      ) {
        instance.setProp(key, newProps[key]);
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
    if (instance.unmap) {
      instance.unmap();
    }
  },

  unhideInstance(instance) {
    if (instance.map) {
      instance.map();
    }
  },

  hideTextInstance() {},
  unhideTextInstance() {},

  detachDeletedInstance() {},
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

function connectAndRender(element, callback) {
  let ntk;
  try {
    ntk = require('ntk');
  } catch (err) {
    throw new Error(
      'react-x11: the optional "ntk" dependency is not available, so react-x11 ' +
        'cannot open an X11 connection by itself. Install ntk (it needs native ' +
        'build tools) or pass a container to render(). Original error: ' +
        err.message,
    );
  }
  ntk.createClient((err, app) => {
    if (err) {
      throw new Error(
        'react-x11: could not connect to the X server. Is an X server running ' +
          `and DISPLAY set (DISPLAY=${process.env.DISPLAY || '<unset>'})? ` +
          'Original error: ' +
          err.message,
      );
    }
    cachedNtkApp = app;
    ReactX11.render(element, callback, app);
  });
}

const ReactX11 = {
  render(element, callback, container) {
    if (!container) {
      if (cachedNtkApp) {
        return ReactX11.render(element, callback, cachedNtkApp);
      }
      connectAndRender(element, callback);
      return;
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

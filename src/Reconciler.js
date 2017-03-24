const ReactFiberReconciler = require('react-dom/lib/ReactFiberReconciler');
const ReactX11Component = require('./Component');

const InstanceManager = {
  get(container) {
    return {
      connection: container,
      current: container
    }
  }
}

const {
  createElement,
  setInitialProperties,
  // diffProperties,
  updateProperties,
} = ReactX11Component;

const TIME_REMAINING = 4;
const precacheFiberNode = (internalInstanceHandle, instance) => null;
const emptyObject = {};

const Renderer = ReactFiberReconciler({
  getRootHostContext(rootContainerInstance) {
    return rootContainerInstance;
  },

  getChildHostContext(parentHostContext, type) {
    // Noop
  },

  prepareForCommit() {
    // Noop
  },

  resetAfterCommit() {
    // Noop
  },

  createInstance(
    type,
    props,
    rootContainerInstance,
    hostContext,
    internalInstanceHandle
  ) {
    const instance  = createElement(type, props, rootContainerInstance, hostContext);
    precacheFiberNode(internalInstanceHandle, instance);
    return instance;
  },

  appendInitialChild(
    parentInstance,
    child
  ) {
    console.log('appendInitialChild!', child)
  },

  finalizeInitialChildren(
    element,
    type,
    props,
    rootContainerInstance
  ) {
    setInitialProperties(element, type, props, rootContainerInstance);
  },

  prepareUpdate(
    instance,
    type,
    oldProps,
    newProps,
    rootContainerInstance,
    hostContext
  ) {
    // TODO: diffing properties here allows the reconciler to reuse work
    //  diffProperties(instance, type, oldProps, newProps, rootContainerInstance);
    return emptyObject;
  },

  commitUpdate(
    instance,
    updatePayload,
    type,
    oldProps,
    newProps,
    internalInstanceHandle
  ) {
    // Update the props handle so that we know which props are the ones with
    // with current event handlers.
    // TODO: uncomment this line : updateFiberProps(instance, newProps);
    // Apply the diff to the DOM node.
    updateProperties(instance, updatePayload, type, oldProps, newProps, internalInstanceHandle);
  },

  shouldSetTextContent(props) {
    return false;
  },

  resetTextContent(element) {
    // NOOP
  },

  createTextInstance(text, internalInstanceHandle) {
    return text;
  },

  commitTextUpdate(
    textInstance,
    oldText,
    newText
  ) {
    // Noop
  },

  appendChild(
    parentInstance,
    child
  ) {
    // Deprecated path for when a `container` is hit which was a hack in stack
    // for being unable to return an array from render.
    if (parentInstance === child) {
      return;
    }

    console.log('TODO: appendChild')
    // parentInstance.appendChild(child);
  },

  insertBefore(
    parentInstance,
    child,
    beforeChild
  ) {
    // This should probably never be called in Hardware.
    console.warn('TODO: insertBefore');
    // parentInstance.insertBefore(child, beforeChild);
  },

  removeChild(parentInstance, child) {
    console.warn('TODO: ReactHardwareRenderer.removeChild');
    // parentInstance.removeChild(child);
  },

  scheduleAnimationCallback: process.nextTick,

  scheduleDeferredCallback: (fn) => setTimeout(fn, TIME_REMAINING, {timeRemaining() { return TIME_REMAINING; }}),

  useSyncScheduling: false,
});

function renderSubtreeIntoContainer(
  parentComponent,
  element,
  container,
  callback
) {
  const root = InstanceManager.get(container);
  if (root) {
    console.log('updateContainer(element, root, parentComponent, callback)', element, root, parentComponent, callback)
    debugger
    Renderer.updateContainer(element, root, parentComponent, callback);
  } else {
    InstanceManager.connect(container, (error, root) => {
      if (error) {
        console.log(error);
      } else {
        const root = Renderer.createContainer(container);
        Renderer.updateContainer(element, root, parentComponent, callback);
        // Renderer.mountContainer(element, root, parentComponent, callback);
      }
    });
  }
}

const defaultContainer = {};
const ReactX11 = {
  render(
    element,
    container,
    callback
  ) {
    console.log('renderSubtreeIntoContainer(null, element, container, callback); ===== ', null, element, container, callback)
    debugger
    return renderSubtreeIntoContainer(null, element, container, callback);
  },

  unmountComponentAtNode(container) {
    const containerKey = typeof container === 'undefined' ? defaultContainer : container;
    const root = roots.get(containerKey);
    if (root) {
      Renderer.unmountContainer(root);
    }
  }
};

if (typeof injectInternals === 'function') {
  injectInternals({
    findFiberByHostInstance: () => null,
    findHostInstanceByFiber: Renderer.findHostInstance,
  });
}

const roots = new Map();

module.exports = ReactX11;

const ReactFiberReconciler = require('react-dom/lib/ReactFiberReconciler');
const ReactX11Component = require('./Component');

const LOG_STEPS = true;
const log = (a, b, c) => {
  if (LOG_STEPS) {
    console.log(a, b, c);
  }
};

const Renderer = ReactFiberReconciler({

  // the tree creation and updating methods. If you’re familiar with the DOM API
  // this will look familiar

  createInstance(
    type,
    props,
    rootContainerInstance,
    hostContext,
    internalInstanceHandle
  ) {

    console.log('====  hostContext', hostContext)
    if (type === 'window') {
      const wnd = rootContainerInstance.createWindow(props);
      wnd.map();
      return wnd;
    } else {
      return {
        type,
        props
      }
    }
  },

  // this is called instead of `appendChild` when the parentInstance is first
  // being created and mounted
  // added in https://github.com/facebook/react/pull/8400/
  appendInitialChild(
    parentInstance,
    child
  ) {
    //
    log('appendInitialChild');
    child.reparentTo(parentInstance, child.x, child.y);
    child.map();
  },

  appendChild(
    parentInstance,
    child
  ) {
    log('appendChild') //, child, parentInstance);
    if (child.id && parentInstance.id) {
      child.reparentTo(parentInstance, child.x, child.y);
      child.map();
    }
    // const index = parentInstance.children.indexOf(child);
    // if (index !== -1) {
    //   parentInstance.children.splice(index, 1);
    // }
    // parentInstance.children.push(child);
  },

  removeChild(
    parentInstance,
    child
  ) {
    log('removeChild', child);
    // parentInstance.removeChild(child);
  },

  insertBefore(
    parentInstance,
    child,
    beforeChild
  ) {
    log('insertBefore');
    // parentInstance.insertBefore(child, beforeChild);
  },

  // finalizeInitialChildren is the final HostConfig method called before
  // flushing the root component to the host environment

  finalizeInitialChildren(
    instance,
    type,
    props,
    rootContainerInstance
  ) {
    log('finalizeInitialChildren');
    // setInitialProperties(instance, type, props, rootContainerInstance);
    //return false;
    return true;
  },

  // prepare update is where you compute the diff for an instance. This is done
  // here to separate computation of the diff to the applying of the diff. Fiber
  // can reuse this work even if it pauses or aborts rendering a subset of the
  // tree.

  prepareUpdate(
    instance,
    type,
    oldProps,
    newProps,
    rootContainerInstance,
    hostContext
  ) {
    log('TODO: prepareUpdate');
    //return null;
    //return diffProperties(instance, type, oldProps, newProps, rootContainerInstance, hostContext);
    return newProps;
  },

  commitUpdate(
    instance,
    updatePayload,
    type,
    oldProps,
    newProps,
    internalInstanceHandle
  ) {
    if (type === 'window') {
      if (newProps.title) {
        instance.setTitle(newProps.title)
      } else {
        instance.setTitle('')
      }
      instance.resize(newProps.width, newProps.height)
    }

    // Apply the diff to the DOM node.
    // updateProperties(instance, updatePayload, type, oldProps, newProps);
    log('TODO: commitUpdate');
  },

  // commitMount is called after initializeFinalChildren *if*
  // `initializeFinalChildren` returns true.

  commitMount(
    instance,
    type,
    newProps,
    internalInstanceHandle
  ) {
    log('commitMount');
    // noop
  },

  // HostContext is an internal object or reference for any bookkeeping your
  // renderer may need to do based on current location in the tree. In DOM this
  // is necessary for calling the correct `document.createElement` calls based
  // upon being in an `html`, `svg`, `mathml`, or other context of the tree.

  getRootHostContext(rootContainerInstance) {
    log('getRootHostContext');
    return {
      rootWindowId: rootContainerInstance.X.display.screen[0].root
    };
  },

  getChildHostContext(parentHostContext, type, rootContainerInstance, a, b, c) {
    log('getChildHostContext', type);
    return {
      parent: parentHostContext,
      type
    };
  },

  // getPublicInstance should be the identity function in 99% of all scenarios.
  // It was added to support the `getNodeMock` functionality for the
  // TestRenderers.

  getPublicInstance(instance) {
    log('getPublicInstance');
    return instance;
  },

  // the prepareForCommit and resetAfterCommit methods are necessary for any
  // global side-effects you need to trigger in the host environment. In
  // ReactDOM this does things like disable the ReactDOM events to ensure no
  // callbacks are fired during DOM manipulations

  prepareForCommit() {
    log('prepareForCommit', arguments);
    // noop
  },

  resetAfterCommit() {
    log('resetAfterCommit');
    // noop
  },

  // the following four methods are regarding TextInstances. In our example
  // renderer we don’t have specific text nodes like the DOM does so we’ll just
  // noop all of them.

  shouldSetTextContent(props, a, b, c, d) {
    log('shouldSetTextContent', props, a, b, c, d);
    if (typeof props.schildren === 'string') {
      return true;
    }
    return false;
  },

  resetTextContent(instance) {
    log('resetTextContent');
    // noop
  },

  createTextInstance(
    text,
    rootContainerInstance,
    hostContext,
    internalInstanceHandle
  )  {
    log('createTextInstance');
    return text;
  },

  commitTextUpdate(
    textInstance,
    oldText,
    newText
  ) {
    console.log('commitTextUpdate', oldText, newText);
    // noop
    throw new Error('commitTextUpdate should not be called');
  },

  scheduleAnimationCallback() {
    log('scheduleAnimationCallback');
  },

  scheduleDeferredCallback() {
    log('scheduleDeferredCallback');
  },

  useSyncScheduling: true,
});

/**
 * Our public renderer. When someone requires your renderer, this is all they
 * should have access to. `render` and `unmountComponentAtNode` methods should
 * be considered required, though that isn’t strictly true.
 */
const defaultContainer = {};
const ReactX11 = {
  render(
    element,
    callback,
    container
  ) {
    if (!container) {
      const ntk = require('ntk')
      ntk.createClient((err, app) => {
        ReactX11.render(element, callback, app);
      })
      return;
    }

    const containerKey = typeof container === 'undefined' ? defaultContainer : container;
    let root = roots.get(containerKey);
    if (!root) {
      root = Renderer.createContainer(containerKey);
      roots.set(container, root);
    }

    Renderer.updateContainer(element, root, null, callback);
    return Renderer.getPublicRootInstance(root);
  },
  unmountComponentAtNode(container) {
    const containerKey = typeof container === 'undefined' ? defaultContainer : container;
    const root = roots.get(containerKey);
    if (root) {
      Renderer.updateContainer(null, root, null, () => {
        roots.delete(container);
      });
    }
  },
  // other API methods you may support, such as `renderPortal()`
};

const roots = new Map();
const emptyObject = {};

module.exports = ReactX11;

var injectInternals = require('react-dom/lib/ReactFiberDevToolsHook').injectInternals;

if (typeof injectInternals === 'function') {
  injectInternals({
    findFiberByHostInstance: () => null,
    findHostInstanceByFiber: Renderer.findHostInstance
  });
}``

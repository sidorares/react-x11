require('./DevToolsIntegration.js')
const ReactFiberReconciler = require('react-dom/lib/ReactFiberReconciler');

const LOG_STEPS = false;//true;
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
    if (type === 'window') {
      var windowAttributes = Object.assign({}, props);
      if (typeof hostContext.rootWindowId === 'undefined') {
        windowAttributes.overrideRedirect = true;
      }
      const wnd = rootContainerInstance.createWindow(windowAttributes);
      console.log('CREATED', wnd.id, props.name)
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
    const instance = parentInstance
    //
    log('appendInitialChild');
    //console.log('appendInitialChild REPARENTING!!! ======= ', child.id, parentInstance.id)
    //setTimeout(() => {
      console.log('appendInitialChild REPARENTING!!! ======= ', child.id, parentInstance.id)

      if (child.reparentTo) {
        //child.reparentTo(parentInstance, 0, 0);//child.x, child.y);
        if (instance.__children) {
          parentInstance.__children.push(child)
        } else {
          parentInstance.__children = [child]
        }
      } else {
        parentInstance.__children = [child]
      }
      //parentInstance.reparentTo(child, child.x, child.y);
      //child.map();
      //parentInstance.map()
    //}, 2000);
  },

  appendChild(
    parentInstance,
    child
  ) {
    log('appendChild', parentInstance.name, child.name);
    if (child.id && parentInstance.id) {
      console.log('appendChild REPARENTING!!! ======= ', child.id, parentInstance.id)
      child.reparentTo(parentInstance, child.x, child.y);
      //child.map();
    }

    const instance = parentInstance
    if (instance.__children) {
      parentInstance.__children.push(child)
    } else {
      parentInstance.__children = [child]
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
    log('removeChild');
    // parentInstance.removeChild(child);
    console.log('Remove child!!!', child.id)
    child.destroy();
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
      if (newProps.title && newProps != oldProps.title) {
        instance.setTitle(newProps.title)
      } else {
        instance.setTitle('')
      }
      if (newProps.width !== oldProps.width || newProps.height !== oldProps.height) {
        instance.resize(newProps.width, newProps.height)
      }
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
    //debugger
    console.log('commitMount:', newProps.name);
    // noop
    if (type === 'window') {
      console.log('instance.__children', instance.__children)
      if (instance.__children) {
        instance.__children.forEach(w => {
          console.log('!!!!!!============', w)
          if (w.reparentTo) {
            w.reparentTo(instance, w.x, w.y)
            w.map()
          }
        })
      }
      if (newProps.top) {
        instance.map()
      }
    }
  },

  getPublicInstance(instance) {
    log('getPublicInstance');
    return instance;
  },

  getRootHostContext(rootContainerInstance) {
    return {
      rootWindowId: rootContainerInstance.X.display.screen[0].root
    };
  },

  getChildHostContext(parentHostContext, type, rootContainerInstance, a, b, c) {
    return {
      parent: parentHostContext,
      type
    };
  },

  // the prepareForCommit and resetAfterCommit methods are necessary for any
  // global side-effects you need to trigger in the host environment. In
  // ReactDOM this does things like disable the ReactDOM events to ensure no
  // callbacks are fired during DOM manipulations

  prepareForCommit() {
    log('prepareForCommit');
  },

  resetAfterCommit() {
    log('resetAfterCommit');
  },

  // the following four methods are regarding TextInstances. In our example
  // renderer we don’t have specific text nodes like the DOM does so we’ll just
  // noop all of them.

  shouldSetTextContent(props) {
    log('shouldSetTextContent');
    return false;

    if (typeof props.children === 'string') {
      return true;
    }
    return false;
  },

  resetTextContent(instance) {
    log('resetTextContent');
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
let cachedNtkApp = null;
const ReactX11 = {
  render(
    element,
    callback,
    container
  ) {
    if (!container) {
      if (cachedNtkApp) {
        return ReactX11.render(element, callback, cachedNtkApp);
      }
      const ntk = require('ntk')
      ntk.createClient((err, app) => {
        cachedNtkApp = app;
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

if (process.env.NODE_ENV !== 'production') {
  var injectInternals = require('react-dom/lib/ReactFiberDevToolsHook').injectInternals;
  if (typeof injectInternals === 'function') {
    injectInternals({
      findFiberByHostInstance: instance => {
        // TODO: implement this
        // not sure yet how to get ref to component or internal
        // instance from HostConfig handlers
      },
      findHostInstanceByFiber: Renderer.findHostInstance
    });
  }
}

module.exports = ReactX11;

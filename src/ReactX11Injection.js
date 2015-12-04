/**
 * React-X11 Dependency Injection
 * ===================================
 *
 * Injecting the renderer's needed dependencies into React's internals.
 */
import ReactInjection from 'react/lib/ReactInjection';
import ReactComponentEnvironment from 'react/lib/ReactComponentEnvironment';
import ReactReconcileTransaction from './ReactReconcileTransaction';

import ReactBlessedComponent from './ReactBlessedComponent';

export default function inject() {

  ReactInjection.NativeComponent.injectGenericComponentClass(
    ReactBlessedComponent
  );

  ReactInjection.Updates.injectReconcileTransaction(
    ReactReconcileTransaction
  );

  ReactInjection.EmptyComponent.injectEmptyComponent('element');

  // NOTE: we're monkeypatching ReactComponentEnvironment because
  // ReactInjection.Component.injectEnvironment() currently throws,
  // as it's already injected by ReactDOM for backward compat in 0.14 betas.
  // Read more: https://github.com/Yomguithereal/react-blessed/issues/5
  ReactComponentEnvironment.processChildrenUpdates = function () {};
  ReactComponentEnvironment.replaceNodeWithMarkupByID = function () {};
}

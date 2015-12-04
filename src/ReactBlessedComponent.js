/*
  based on react-blessed by Guillaume Plique
  see https://github.com/Yomguithereal/react-blessed

  https://github.com/Yomguithereal/react-blessed/blob/master/LICENSE.txt
*/

import ReactMultiChild from 'react/lib/ReactMultiChild';
import IDOperations from './IDOperations.js';

import invariant from 'invariant';
import update from './update';

import {extend, groupBy, startCase} from 'lodash';

import RootComponent from './root_component.js';

/**
 * Variable types that must be solved as content rather than real children.
 */
const CONTENT_TYPES = {string: true, number: true};

/**
 * Renders the given react element with blessed.
 *
 * @constructor ReactBlessedComponent
 * @extends ReactMultiChild
 */

  export default class ReactBlessedComponent {
  constructor(tag) {
    this._tag = tag.toLowerCase();
    this._renderedChildren = null;
    this._previousStyle = null;
    this._previousStyleCopy = null;
    this._rootNodeID = null;
    this._wrapperState = null;
    this._topLevelWrapper = null;
    this._nodeWithLegacyProperties = null;
  }

  construct(element) {
    // Setting some properties
    this._currentElement = element;

    //TODO events
    this._eventListener = (type, ...args) => {
      const handler = this._currentElement.props['on' + startCase(type)];

      if (typeof handler === 'function')
        handler.apply(null, args);
    };
  }

  /**
   * Mounting the root component.
   *
   * @internal
   * @param  {string} rootID - The root blessed ID for this node.
   * @param  {ReactBlessedReconcileTransaction} transaction
   * @param  {object} context
   */
  mountComponent(rootID, transaction, context) {
    this._rootNodeID = rootID;

    // Mounting blessed node
    const node = this.mountNode(
      IDOperations.getParent(rootID),
      this._currentElement
    );

    IDOperations.add(rootID, node);

    // Mounting children
    let childrenToUse = this._currentElement.props.children;
    childrenToUse = childrenToUse === null ? [] : [].concat(childrenToUse);

    if (childrenToUse.length) {

      // Discriminating content components from real children
      const {content=null, realChildren=[]} = groupBy(childrenToUse, (c) => {
        return CONTENT_TYPES[typeof c] ? 'content' : 'realChildren';
      });

      // Setting textual content
      if (content)
        node.setContent('' + content.join(''));

      // Mounting real children
      this.mountChildren(
        realChildren,
        transaction,
        context
      );
    }

    // Rendering the screen
    IDOperations.screen.debouncedRender();
  }

  /**
   * Mounting the blessed node itself.
   *
   * @param   {BlessedNode|BlessedScreen} parent  - The parent node.
   * @param   {ReactElement}              element - The element to mount.
   * @return  {BlessedNode}                       - The mounted node.
   */
  mountNode(parent, element) {
    const {props, type} = element,
          {children, ...options} = props;

    var blessedElement = RootComponent.createElement(type, props);

    invariant(
      !!blessedElement,
      `Invalid blessed element "${type}".`
    );

    const node = blessedElement.getNode(parent);

    console.log('TODO: add event mapping');
    console.trace();
    //node.on('event', this._eventListener);

    //console.log([parent]);
    parent.append(node);

    return node;
  }

  /**
   * Receive a component update.
   *
   * @param {ReactElement}              nextElement
   * @param {ReactReconcileTransaction} transaction
   * @param {object}                    context
   * @internal
   * @overridable
   */
  receiveComponent(nextElement, transaction, context) {
    const {props: {children, ...options}} = nextElement,
          node = IDOperations.get(this._rootNodeID);

    update(node, options);

    // Updating children
    const childrenToUse = children === null ? [] : [].concat(children);

    // Discriminating content components from real children
    const {content=null, realChildren=[]} = groupBy(childrenToUse, (c) => {
      return CONTENT_TYPES[typeof c] ? 'content' : 'realChildren';
    });

    // Setting textual content
    if (content)
      node.setContent('' + content.join(''));


    this.updateChildren(realChildren, transaction, context);

    //this.updateChildren(children, transaction, context);


    IDOperations.screen.debouncedRender();
  }

  /**
   * Dropping the component.
   */
  unmountComponent() {
    this.unmountChildren();

    const node = IDOperations.get(this._rootNodeID);
    const parentNode = IDOperations.getParent(this._rootNodeID);

    node.off('event', this._eventListener);
    node.destroy();
    parentNode.removeChild(node);

    IDOperations.drop(this._rootNodeID);

    this._rootNodeID = null;

    IDOperations.screen.debouncedRender();
  }

  /**
   * Getting a public instance of the component for refs.
   *
   * @return {BlessedNode} - The instance's node.
   */
  getPublicInstance() {
    return IDOperations.get(this._rootNodeID);
  }
}

/**
 * Extending the component with the MultiChild mixin.
 */
extend(
  ReactBlessedComponent.prototype,
  ReactMultiChild.Mixin
);

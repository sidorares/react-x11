/**

  based on react-blessed by Guillaume Plique
  see https://github.com/Yomguithereal/react-blessed

  https://github.com/Yomguithereal/react-blessed/blob/master/LICENSE.txt

 * React X11 ID Operations
 * ============================
 *
 * Cache register for x11 nodes stored by ID.
 */
import {debounce} from 'lodash';

/**
 * nodes internal index;
 */
const Nodes = {};

/**
 *
 * @constructor IDOperations
 */
class IDOperations {

  constructor() {
    this.screen = null;
  }

  setRootComponent(screen) {
    this.screen = screen;

    // Creating a debounced version of the render method so we won't render
    // multiple time per frame, in vain.
    screen.debouncedRender = debounce(() => screen.render(), 0);
    return this;
  }

  /**
   * Add a new node to the index.
   *
   * @param  {string}      ID           - The node's id.
   * @param  {BlessedNode} node         - The node itself.
   * @return {ReactBlessedIDOperations} - Returns itself.
   */
  add(ID, node) {
    node.reactId = ID;
    Nodes[ID] = node;
    return this;
  }

  /**
   * Get a node from the index.
   *
   * @param  {string}      ID - The node's id.
   * @return {BlessedNode}    - The node.
   */
  get(ID) {
    console.log('GET', ID);
    return Nodes[ID];
  }

  /**
   * Get the parent of a node from the index.
   *
   * @param  {string}                    ID - The node's id.
   * @return {BlessedScreen|BlessedNode}    - The node.
   */
  getParent(ID) {

    // If the node is root, we return the screen itself
    if (ID.match(/\./g).length === 1)
      return this.screen;

    const parentID = ID.split('.').slice(0, -1).join('.');
    return this.get(parentID);
  }

  /**
   * Drop a node from the index.
   *
   * @param  {string}                   ID - The node's id.
   * @return {ReactBlessedIDOperations}    - Returns itself.
   */
  drop(ID) {
    console.log('DELETE:', ID);
    delete Nodes[ID];
    return this;
  }
}

export default new IDOperations();

// <box>: a node that scrolls.

import { Node } from './node.js';
import { Scrollable } from './scrollable.js';

/**
 * The flex container — and, with `overflow: 'scroll'`, the scroll container
 * too. There is no separate scrolling element: see `Scrollable`.
 */
export class BoxNode extends Scrollable(Node) {
  constructor(props, app) {
    super('box', props, app);
  }

  /** A box draws a fill and a border and no text at all, so a new ink or a
   * new face costs it nothing — it is only ever the *source* of one. The
   * nodes inside it claim their own damage as the walk reaches them, which
   * keeps hovering a long list bounded to the labels rather than to the
   * list. */
  _textStyleMoved() {}
}

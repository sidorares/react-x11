// CSS's `currentColor`: the colour keyword that is not a colour yet.
//
// A leaf, like decorations.js, because every layer that reads a colour asks
// about it — the grammar (styles.js, shorthands.js, decorations.js) to let
// it through, and the paint (nodes/boxpaint.js and every backend's reader
// of a style colour) to resolve it.
//
// It stays the keyword in `node.style` — CSS's computed value — and becomes
// a colour only where something is about to paint it, against the node's
// resolved ink (`Node.resolveColor`). Resolving it once in the style funnel
// instead would bake the ink into the style object, which no inherited
// change reaches: a `:hover { color }` on a row moves the ink of every node
// under it without restyling any of them.

/** `currentColor`, spelled any way CSS accepts — its keywords are ASCII
 *  case-insensitive — and with the whitespace a style value may carry. */
const KEYWORD = /^\s*currentcolor\s*$/i;
const MENTION = /currentcolor/i;

/** Whether `value` is the keyword. Asked per colour per paint, so a value
 *  too short to be it is answered without the match. */
export const isCurrentColor = (value) =>
  typeof value === 'string' && value.length >= 12 && KEYWORD.test(value);

/** Whether a value made of several — a gradient, a shadow list — names the
 *  keyword anywhere in it. */
export const mentionsCurrentColor = (value) =>
  typeof value === 'string' && value.length >= 12 && MENTION.test(value);

// Ranges over text, in the units the caret is in.
//
// Everything here is pure and takes an array of code points, because that is
// the index space ntk's `TextLayout.caretPosition`/`indexAt` speak and
// therefore the one every caret and every selection in this renderer is in
// (a code point, not a UTF-16 unit — an emoji is one position, not two).
//
// It is its own module because two unrelated things need the same answers:
// `<textinput>`'s editing keys, and the selection a reader drags across a
// document (textselection.js). A double click has to pick the same word in
// both, and Ctrl+Left has to stop where a double click would start.

/** The code points of a string, which is the index space of every caret. */
export function codePoints(text) {
  return Array.from(text ?? '');
}

/**
 * Code point index -> UTF-16 offset, with one extra entry for the end.
 *
 * ntk's line runs report their extent in **code units** while its caret API
 * speaks code points, so anything that reads run geometry has to translate
 * between them; this is the table that does it.
 */
export function codeUnitOffsets(text) {
  const offsets = [];
  const s = text ?? '';
  for (let i = 0; i < s.length;) {
    offsets.push(i);
    i += s.codePointAt(i) > 0xffff ? 2 : 1;
  }
  offsets.push(s.length);
  return offsets;
}

/** The code point index for a UTF-16 offset, rounded down to a whole
 * character. Binary search over `codeUnitOffsets`. */
export function codePointAtOffset(offsets, offset) {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * The word around an index, the way a double click selects one:
 * whitespace-delimited, and a click in the space between two words takes the
 * word before it rather than nothing.
 */
export function wordRangeAt(chars, index) {
  if (chars.length === 0) return [0, 0];
  let i = Math.min(Math.max(0, index), chars.length - 1);
  const isSpace = (c) => /\s/.test(c);
  if (isSpace(chars[i]) && i > 0) i--;
  let a = i;
  let b = i;
  while (a > 0 && !isSpace(chars[a - 1])) a--;
  while (b < chars.length && !isSpace(chars[b])) b++;
  return [a, b];
}

/**
 * The index one word away, the way Ctrl+arrow moves in a text editor: skip
 * any run of non-word characters, then the word itself. Word characters are
 * letters, digits and underscore, so "foo-bar" is two words and "foo_bar" is
 * one.
 */
export function wordBoundary(chars, from, dir) {
  const isWord = (c) => /[\p{L}\p{N}_]/u.test(c);
  let i = Math.max(0, Math.min(from, chars.length));
  if (dir > 0) {
    while (i < chars.length && !isWord(chars[i])) i++;
    while (i < chars.length && isWord(chars[i])) i++;
  } else {
    while (i > 0 && !isWord(chars[i - 1])) i--;
    while (i > 0 && isWord(chars[i - 1])) i--;
  }
  return i;
}

// Accelerators: the half of a menu `shortcut` that was only ever drawn (#351).
//
// A `MenuBar` measured its items' shortcuts, drew them, announced them as
// `aria-keyshortcuts` and handed them to the panel as dbusmenu's `aas` — and
// bound none of them. An app wrote the binding a second time in an
// `onKeyDown`, so the promise on the screen and the behaviour behind it were
// two pieces of state that drifted.
//
// This is the matching half, and it is pure: an event and a chord in, a
// boolean out. The registry and the dispatch order live in `events.js`, next
// to the key path they are part of; the React lid is `acceleratorhooks.js`.
//
// ## Which keysym a chord is compared against
//
// `ev.keysym` — the **Latin** keysym for the physical key, whatever layout is
// live (`src/keyboard.js`, docs/events.md). That is what makes Ctrl+S keep
// saving while the user types Russian, and it is the reason this module has
// nothing to say about layouts at all.
//
// ## Exact on the four modifiers, indifferent to the locks
//
// Ctrl+S must not fire on Ctrl+Shift+S, and must still fire with Caps Lock or
// Num Lock on. Both fall out of comparing `ctrlKey`/`altKey`/`shiftKey`/
// `metaKey`, which are the four named modifier bits and nothing else: Lock is
// bit 1 and Num Lock is normally Mod2, so neither is in the comparison to
// begin with. This is the line every hand-rolled binding gets wrong, which is
// most of why it is here rather than in an application.

import {
  isEnabled,
  isSeparator,
  splitChord,
  visibleItems,
} from './menuitem.js';
import { keysymFromName } from './keysyms.js';

/** ASCII upper case folded down, so `'S'` and `'s'` are the same key. */
const fold = (keysym) =>
  keysym >= 0x41 && keysym <= 0x5a ? keysym + 0x20 : keysym;

const isLetter = (keysym) => fold(keysym) >= 0x61 && fold(keysym) <= 0x7a;

/** The keysym one chord ends on, or `undefined` for one nothing can match. */
export function chordKeysym(chord) {
  const { key } = splitChord(chord);
  return key == null ? undefined : keysymFromName(key);
}

/**
 * Does this key event *press* `chord` — `['Control', 'S']`?
 *
 * Two ways a chord's key can be recognised, and the second exists for the
 * symbols:
 *
 * - **as the key it names.** `ev.keysym` is the Latin keysym for the physical
 *   key, case-folded here because dbusmenu carries the key and not the
 *   character it types, so `['Control', 's']` and `['Control', 'S']` are one
 *   binding. All four modifiers are compared exactly.
 * - **as the character it typed.** `['Control', 'plus']` is a real shortcut
 *   that no US keyboard can press without Shift — `+` is the shifted `=` — so
 *   comparing the base keysym alone would draw `Ctrl++` and never fire it.
 *   Where the chord names a symbol, the character the key actually produced
 *   counts too, and Shift is then whatever it took to produce it rather than
 *   a modifier of its own. GTK reaches the same answer through XKB's consumed
 *   modifiers; this is that rule with the part we cannot ask the server for
 *   left out.
 *
 * The second path is **letters excluded** deliberately: it is exactly what
 * would make Ctrl+Shift+S fire a Ctrl+S binding, which is the thing the
 * modifier comparison is here to prevent.
 */
export function matchesChord(ev, chord) {
  const { modifiers, key } = splitChord(chord);
  if (key == null) return false;
  const wanted = keysymFromName(key);
  if (wanted === undefined) return false;

  const ctrl = modifiers.has('Control');
  const alt = modifiers.has('Alt');
  const shift = modifiers.has('Shift');
  const meta = modifiers.has('Super');
  if (
    Boolean(ev?.ctrlKey) !== ctrl ||
    Boolean(ev?.altKey) !== alt ||
    Boolean(ev?.metaKey) !== meta
  ) {
    return false;
  }

  const pressed = ev?.keysym;
  if (typeof pressed === 'number' && fold(pressed) === fold(wanted)) {
    return Boolean(ev?.shiftKey) === shift;
  }
  if (isLetter(wanted)) return false;
  // The character this key typed, which is where a Shift the layout needed
  // has already been spent — so a chord that did not ask for Shift does not
  // mind one here, and one that did still gets it.
  return (!shift || Boolean(ev?.shiftKey)) && ev?.codepoint === wanted;
}

/** Does this key event press any alternative of an `aas` shortcut? */
export function matchesShortcut(ev, shortcut) {
  if (!Array.isArray(shortcut)) return false;
  return shortcut.some(
    (chord) => Array.isArray(chord) && matchesChord(ev, chord),
  );
}

/**
 * The item in a menu descriptor whose shortcut this key event presses, or
 * `null` — submenus included, since a shortcut is a way to reach a command
 * *without* opening the menu it lives in.
 *
 * `enabled` and `visible` gate the search rather than the result, and they
 * gate a parent's children with it: an item nobody can reach by opening the
 * menu is not one a chord should reach either. A gated item is skipped and
 * the walk goes on, so a disabled "Save" does not also swallow the key from
 * whatever else claims it.
 */
export function acceleratedItem(items, ev) {
  for (const item of visibleItems(items)) {
    if (isSeparator(item) || !isEnabled(item)) continue;
    if (matchesShortcut(ev, item.shortcut)) return item;
    const inner = acceleratedItem(item.items, ev);
    if (inner) return inner;
  }
  return null;
}

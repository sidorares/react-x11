// The menu item vocabulary, shared by the component that draws menus
// (`components/Menu.js`) and the one that hands them to the desktop
// (`dbusmenu.js`).
//
// ## Why the names are the desktop's names
//
// A `MenuBar` is either drawn by us or drawn by the panel, and the app is not
// told which — that is the whole point of the feature. So the descriptor has
// to be equally at home in both, and only one of the two ends gets a vote on
// what things are called: `com.canonical.dbusmenu` is a wire protocol with a
// published item vocabulary, and we are one of many exporters.
//
// Hence `type: 'separator'` rather than `separator: true`, `enabled: false`
// rather than `disabled: true`, `toggleType`/`toggleState` rather than a bare
// `checked`, and `shortcut` as dbusmenu's `aas` rather than a display string.
// Each one used to be the shape a drawn-only menu would pick; each one now
// serialises with no translation, which is what keeps `menus` a single
// authoring model instead of a drawn one and an exported one that drift.
//
// The one deliberate exception is `icon`, which stays a react-x11 callback and
// is **not** serialisable — see `gutterMark` in `components/Menu.js`. The
// desktop cannot call a function, so `iconName` and `iconData` are what cross
// the bus, and an item may carry both: the drawing for our own menu, the theme
// name for the panel's.

/** A rule instead of a row. dbusmenu's `type` property, whose only other legal value is `'standard'`. */
export const isSeparator = (item) => item?.type === 'separator';

/** dbusmenu defaults `enabled` and `visible` to true, so absent means yes. */
export const isEnabled = (item) => item?.enabled !== false;
export const isVisible = (item) => item?.visible !== false;

/** Can the selection land here? Separators and disabled rows cannot take it. */
export const isSelectable = (item) =>
  Boolean(item) && !isSeparator(item) && isEnabled(item);

/**
 * dbusmenu's `children-display: submenu` — a fact about the children, and
 * about the **visible** ones: a parent whose every child is hidden opens onto
 * nothing, so neither our chevron nor the panel's arrow should promise a
 * submenu that is empty when it arrives.
 */
export const hasSubmenu = (item) => (item?.items ?? []).some(isVisible);

/** Rows the user can see. A hidden item is not laid out, not just not drawn. */
export const visibleItems = (items) => (items ?? []).filter(isVisible);

// --------------------------------------------------------------------------
// Shortcuts
// --------------------------------------------------------------------------

// How dbusmenu spells the modifiers. The key token is whatever is left over
// after them, and it comes last.
const MODIFIERS = new Set(['Control', 'Alt', 'Shift', 'Super']);

// What a person reads. `Control` is the wire spelling and `Ctrl` is the one
// every desktop puts in front of a user, which is the entire reason this map
// is not an identity.
const MODIFIER_LABELS = {
  Control: 'Ctrl',
  Alt: 'Alt',
  Shift: 'Shift',
  Super: 'Super',
};

// Keys whose name and whose printed form differ. libdbusmenu names a key the
// way GDK does — `gdk_keyval_name()`, so `plus` rather than `+` — and that is
// what a panel's importer expects to parse. It is not what a menu should
// print: `Ctrl+plus` is nobody's idea of a shortcut. Only the ones that
// actually read badly are here; `F1`, `Delete` and `Home` print themselves.
const KEY_LABELS = {
  plus: '+',
  minus: '-',
  equal: '=',
  comma: ',',
  period: '.',
  slash: '/',
  backslash: '\\',
  bracketleft: '[',
  bracketright: ']',
  semicolon: ';',
  apostrophe: "'",
  grave: '`',
  space: 'Space',
  Return: 'Enter',
  BackSpace: 'Backspace',
  Prior: 'PgUp',
  Next: 'PgDn',
};

/**
 * One `aas` alternative — `['Control', 'S']` — as the string a menu row
 * shows: `Ctrl+S`.
 *
 * A single-character key is upper-cased because that is how every toolkit
 * prints one, and because dbusmenu carries the *key*, not the character it
 * types: `['Control', 's']` and `['Control', 'S']` are the same binding and
 * must not render differently.
 */
function formatChord(chord) {
  const parts = [];
  let key = null;
  for (const token of chord) {
    if (MODIFIERS.has(token)) parts.push(MODIFIER_LABELS[token]);
    else key = token;
  }
  if (key != null) {
    parts.push(KEY_LABELS[key] ?? (key.length === 1 ? key.toUpperCase() : key));
  }
  return parts.join('+');
}

/**
 * `item.shortcut` as the text drawn to the right of a label, or `''`.
 *
 * The prop is dbusmenu's `aas`: a list of **alternatives**, each a list of
 * modifier tokens ending in the key. Only the first alternative is drawn —
 * a row has one shortcut column, and a menu that printed `Ctrl+S / F2` in it
 * would be wider than the menu for the benefit of the rarer binding.
 */
export function formatShortcut(shortcut) {
  const first = shortcut?.[0];
  if (!Array.isArray(first) || first.length === 0) return '';
  return formatChord(first);
}

// What UI Events calls the modifiers, which is what `aria-keyshortcuts` is
// specified in terms of. Only `Super` differs from dbusmenu's spelling.
const ARIA_MODIFIERS = {
  Control: 'Control',
  Alt: 'Alt',
  Shift: 'Shift',
  Super: 'Meta',
};

/**
 * `item.shortcut` as `aria-keyshortcuts`, or `undefined`.
 *
 * A space-delimited list of `+`-joined chords, which is exactly the shape
 * dbusmenu's `aas` already has — so unlike the drawn menu, **every**
 * alternative is announced rather than only the first: a screen reader is
 * reading them out, not fitting them in a column.
 */
export function ariaKeyShortcuts(shortcut) {
  if (!isValidShortcut(shortcut)) return undefined;
  return shortcut
    .map((chord) =>
      chord
        .map((token) =>
          MODIFIERS.has(token)
            ? ARIA_MODIFIERS[token]
            : (KEY_LABELS[token] ?? token),
        )
        .join('+'),
    )
    .join(' ');
}

/**
 * Is this a well-formed `aas`? Used by the development-time check below, and
 * by the exporter, which must not put a malformed shortcut on the wire —
 * dbus-native would throw mid-marshal, inside a method reply, where the
 * failure surfaces as a panel with no menu rather than as an error here.
 */
export function isValidShortcut(shortcut) {
  return (
    Array.isArray(shortcut) &&
    shortcut.length > 0 &&
    shortcut.every(
      (chord) =>
        Array.isArray(chord) &&
        chord.length > 0 &&
        chord.every((token) => typeof token === 'string' && token.length > 0),
    )
  );
}

let warnedAboutShortcut = false;

/**
 * The one shape mistake worth catching for the app author, because both of
 * its failure modes are silent: `shortcut: 'Ctrl+S'` is a string, so
 * `shortcut[0]` is `'C'` and the row draws `C` — and the exporter drops it,
 * so the panel shows no shortcut at all and nothing anywhere says why.
 */
export function checkShortcut(item) {
  if (process.env.NODE_ENV === 'production') return;
  if (item?.shortcut == null || isValidShortcut(item.shortcut)) return;
  if (warnedAboutShortcut) return;
  warnedAboutShortcut = true;
  console.warn(
    `react-x11: a menu item's \`shortcut\` should be dbusmenu's \`aas\` — a ` +
      'list of alternatives, each a list of modifier tokens ending in the ' +
      `key — but ${JSON.stringify(item.shortcut)} is not one. Write:\n` +
      "  { label: 'Save', shortcut: [['Control', 'S']] }\n" +
      'Modifier tokens are Control, Alt, Shift and Super.',
  );
}

/** Test seam: the warning above fires once per process. */
export function _resetShortcutWarning() {
  warnedAboutShortcut = false;
}

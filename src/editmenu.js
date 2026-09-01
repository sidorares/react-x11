/**
 * The standard edit menu — its rows, their geometry and their painting.
 *
 * A browser gives `<input>` a context menu without being asked, and that is
 * the bar here: a bare `<textinput>` gets Undo/Cut/Copy/Paste with no
 * wiring at all. That rules out building it from the `Menu` components,
 * which live a layer above the nodes and cannot be mounted from one — so
 * the rows are measured and drawn here, and a node hangs them in a
 * `<popup>` (`openEditMenu`, nodes.js, which is the public seam).
 *
 * Deliberately free of node imports: this takes plain data, a measuring
 * function and a 2d context. It can be tested without a tree, and falls
 * back to fixed metrics when there are no fonts, which is how the headless
 * tests see it.
 *
 * The item vocabulary is the one `MenuBar` uses — `type: 'separator'`, a
 * `shortcut` as dbusmenu's `aas` — even though these rows never reach a bus:
 * two spellings for "separator" in one codebase is a trap for whoever writes
 * the third menu. `editMenuGeometry` normalises both into the row it returns,
 * so everything below it works on a boolean and a string.
 */
import { formatShortcut, isSeparator } from './menuitem.js';

// Logical px, multiplied by the display scale where they are used: the
// menu's text is measured and painted in device pixels (fonts are sized on
// the device grid), so the chrome around it has to live on the same grid —
// unscaled constants against scaled glyph ink is rows shorter than their
// own labels (the compact-menu bug, first seen on the 2x Cocoa backend).
const ROW_HEIGHT = 22;
const SEPARATOR_HEIGHT = 7;
const PAD_X = 10;
const PAD_Y = 4;
const SHORTCUT_GAP = 28;
const MIN_WIDTH = 150;
// headless (no fonts): enough to keep the rows a plausible size
const FALLBACK_CHAR_WIDTH = 7;

/** Matches the widget palette's defaults, so the built-in menu and a
 * `ContextMenu` next to it do not look like different toolkits. */
export const EDIT_MENU_COLORS = {
  background: 'white',
  border: '#b2bec3',
  text: '#2d3436',
  dim: '#7f8c8d',
  highlight: '#2980b9',
  highlightText: 'white',
  separator: '#dfe6e9',
};

/** Palette for a node: its theme where it has one, defaults otherwise. */
export function editMenuColors(theme) {
  if (!theme) return EDIT_MENU_COLORS;
  return {
    background: theme.surface ?? EDIT_MENU_COLORS.background,
    border: theme.border ?? EDIT_MENU_COLORS.border,
    text: theme.text ?? EDIT_MENU_COLORS.text,
    dim: theme.textMuted ?? EDIT_MENU_COLORS.dim,
    highlight: theme.hoverBackground ?? EDIT_MENU_COLORS.highlight,
    highlightText: theme.hoverText ?? EDIT_MENU_COLORS.highlightText,
    separator: theme.track ?? EDIT_MENU_COLORS.separator,
  };
}

/**
 * The rows, in the standard order, each enabled exactly when it would do
 * something — the whole of the menu's policy, as a pure function of the
 * verbs a target offers (`openEditMenu`, nodes.js).
 *
 * **A verb that was not handed over is a row that is not there**, rather
 * than a greyed one. It was motivated by `<textinput sensitive>`, where a
 * disabled Copy over a password reads as a bug in the application rather
 * than as a decision — but it is also exactly what a surface with nothing
 * to edit needs: a read-only view that offers `copy` and `selectAll` gets a
 * two-row menu, not six rows with four of them dead. So this is the rule,
 * not an exception in the field: never render a verb the caller withheld.
 *
 * Enablement is the other half and is *not* the caller's to decide row by
 * row: Cut and Copy follow the selection, Paste follows what the server
 * says about the clipboard, and Undo/Redo/Select All follow the three
 * `can*` answers only their owner can give. One implementation of that is
 * the point of the seam.
 *
 * @param {object} actions the verb interface — see `openEditMenu`
 * @param {{canPaste?: boolean}} [state] what only the connection knows
 */
export function editMenuItems(actions = {}, { canPaste = true } = {}) {
  const has = (verb) => typeof actions[verb] === 'function';
  const selected = Boolean(actions.hasSelection);
  const groups = [
    [
      has('undo') && {
        id: 'undo',
        label: 'Undo',
        shortcut: [['Control', 'Z']],
        enabled: Boolean(actions.canUndo),
      },
      has('redo') && {
        id: 'redo',
        label: 'Redo',
        shortcut: [['Control', 'Shift', 'Z']],
        enabled: Boolean(actions.canRedo),
      },
    ],
    [
      has('cut') && {
        id: 'cut',
        label: 'Cut',
        shortcut: [['Control', 'X']],
        enabled: selected,
      },
      has('copy') && {
        id: 'copy',
        label: 'Copy',
        shortcut: [['Control', 'C']],
        enabled: selected,
      },
      has('paste') && {
        id: 'paste',
        label: 'Paste',
        shortcut: [['Control', 'V']],
        enabled: canPaste,
      },
    ],
    [
      has('selectAll') && {
        id: 'selectAll',
        label: 'Select All',
        shortcut: [['Control', 'A']],
        // the default is "there is something to select": only the target
        // knows when everything already is
        enabled: actions.canSelectAll !== false,
      },
    ],
  ]
    .map((group) => group.filter(Boolean))
    .filter((group) => group.length > 0);
  // a separator between the groups that survived, and never one at either
  // end — a menu missing a whole group must not show the gap where it was
  return groups.flatMap((group, i) =>
    i === 0 ? group : [{ type: 'separator' }, ...group],
  );
}

/**
 * Lay the rows out and size the popup that holds them.
 *
 * @param {Array<{id?, label?, shortcut?, type?, enabled?}>} items
 * @param {(text: string) => number|null} [measure] text width, or null when
 *   nothing can be measured yet
 */
export function editMenuGeometry(items, measure, scale = 1) {
  const widthOf = (text) => {
    if (!text) return 0;
    const w = measure?.(text);
    return typeof w === 'number' && w > 0
      ? w
      : text.length * FALLBACK_CHAR_WIDTH * scale;
  };
  const rows = [];
  let y = PAD_Y * scale;
  let widest = 0;
  for (const item of items) {
    const separator = isSeparator(item);
    const shortcut = formatShortcut(item.shortcut);
    const height = (separator ? SEPARATOR_HEIGHT : ROW_HEIGHT) * scale;
    rows.push({ ...item, separator, shortcut, y, height });
    y += height;
    if (separator) continue;
    widest = Math.max(
      widest,
      widthOf(item.label) +
        (shortcut ? SHORTCUT_GAP * scale + widthOf(shortcut) : 0),
    );
  }
  return {
    rows,
    scale,
    width: Math.max(MIN_WIDTH * scale, Math.ceil(widest + PAD_X * scale * 2)),
    height: Math.ceil(y + PAD_Y * scale),
  };
}

/** Row under a y coordinate, or -1. Separators and disabled rows are not
 * hoverable — moving onto one clears the highlight rather than leaving a
 * stale row lit. */
export function editMenuIndexAt(geometry, y) {
  for (let i = 0; i < geometry.rows.length; i++) {
    const row = geometry.rows[i];
    if (row.separator || row.enabled === false) continue;
    if (y >= row.y && y < row.y + row.height) return i;
  }
  return -1;
}

/** The next selectable row in `dir`, wrapping, or -1 if there are none. */
export function editMenuStep(geometry, from, dir) {
  const rows = geometry.rows;
  if (rows.length === 0) return -1;
  let i = from < 0 ? (dir > 0 ? -1 : rows.length) : from;
  for (let k = 0; k < rows.length; k++) {
    i += dir;
    if (i < 0) i = rows.length - 1;
    if (i >= rows.length) i = 0;
    const row = rows[i];
    if (!row.separator && row.enabled !== false) return i;
  }
  return -1;
}

function panelPath(ctx, width, height, radius) {
  ctx.beginPath();
  if (radius > 0 && typeof ctx.roundRect === 'function') {
    ctx.roundRect(0.5, 0.5, width - 1, height - 1, radius);
  } else {
    ctx.rect(0.5, 0.5, width - 1, height - 1);
  }
}

/**
 * @param {object} ctx ntk 2d context, translated to the popup's origin
 * @param {object} opts
 * @param {(text: string, color: string) => object|null} opts.layoutOf shaped
 *   text, or null when there are no fonts — the rows still paint, unlabelled
 */
export function paintEditMenu(
  ctx,
  { geometry, active = -1, colors = EDIT_MENU_COLORS, layoutOf, radius = 4 },
) {
  const { width, height, rows } = geometry;
  const s = geometry.scale ?? 1;
  const padX = PAD_X * s;

  panelPath(ctx, width, height, radius * s);
  ctx.fillStyle = colors.background;
  ctx.fill();
  ctx.strokeStyle = colors.border;
  ctx.lineWidth = s;
  ctx.stroke();

  const label = (text, color, x, row) => {
    const layout = layoutOf?.(text, color);
    if (!layout) return;
    const line = layout.lines?.[0];
    const ink = line ? line.ascent + line.descent : layout.height;
    layout.draw(ctx, x, row.y + Math.max(0, (row.height - ink) / 2));
  };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.separator) {
      ctx.fillStyle = colors.separator;
      ctx.fillRect(
        padX,
        Math.round(row.y + row.height / 2) + 0.5,
        width - padX * 2,
        s,
      );
      continue;
    }
    const disabled = row.enabled === false;
    const on = i === active && !disabled;
    if (on) {
      ctx.fillStyle = colors.highlight;
      ctx.fillRect(1, row.y, width - 2, row.height);
    }
    const color = disabled
      ? colors.dim
      : on
        ? colors.highlightText
        : colors.text;
    label(row.label, color, padX, row);
    if (row.shortcut) {
      // the shortcut column stays quieter than the label, except in the
      // highlighted row where it has to stay legible on the accent
      const shortcutColor = on ? colors.highlightText : colors.dim;
      const layout = layoutOf?.(row.shortcut, shortcutColor);
      const w = layout?.width ?? 0;
      label(row.shortcut, shortcutColor, width - padX - w, row);
    }
  }
}

/**
 * The built-in edit menu for `<textinput>` / `<textarea>` — geometry and
 * painting.
 *
 * A browser gives `<input>` a context menu without being asked, and that is
 * the bar here: a bare `<textinput>` gets Undo/Cut/Copy/Paste with no
 * wiring at all. That rules out building it from the `Menu` components,
 * which live a layer above the nodes and cannot be mounted from one — so
 * the rows are measured and drawn here, and the node hangs them in a
 * `<popup>` (see `TextInputNode._openEditMenu`).
 *
 * Deliberately free of node imports: this takes plain data, a measuring
 * function and a 2d context. It can be tested without a tree, and falls
 * back to fixed metrics when there are no fonts, which is how the headless
 * tests see it.
 */

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
    background: theme.background ?? EDIT_MENU_COLORS.background,
    border: theme.border ?? EDIT_MENU_COLORS.border,
    text: theme.text ?? EDIT_MENU_COLORS.text,
    dim: theme.dim ?? EDIT_MENU_COLORS.dim,
    highlight: theme.hoverBackground ?? EDIT_MENU_COLORS.highlight,
    highlightText: theme.hoverText ?? EDIT_MENU_COLORS.highlightText,
    separator: theme.track ?? EDIT_MENU_COLORS.separator,
  };
}

/**
 * Lay the rows out and size the popup that holds them.
 *
 * @param {Array<{id?, label?, shortcut?, separator?, enabled?}>} items
 * @param {(text: string) => number|null} [measure] text width, or null when
 *   nothing can be measured yet
 */
export function editMenuGeometry(items, measure) {
  const widthOf = (text) => {
    if (!text) return 0;
    const w = measure?.(text);
    return typeof w === 'number' && w > 0
      ? w
      : text.length * FALLBACK_CHAR_WIDTH;
  };
  const rows = [];
  let y = PAD_Y;
  let widest = 0;
  for (const item of items) {
    const height = item.separator ? SEPARATOR_HEIGHT : ROW_HEIGHT;
    rows.push({ ...item, y, height });
    y += height;
    if (item.separator) continue;
    widest = Math.max(
      widest,
      widthOf(item.label) +
        (item.shortcut ? SHORTCUT_GAP + widthOf(item.shortcut) : 0),
    );
  }
  return {
    rows,
    width: Math.max(MIN_WIDTH, Math.ceil(widest + PAD_X * 2)),
    height: Math.ceil(y + PAD_Y),
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

  panelPath(ctx, width, height, radius);
  ctx.fillStyle = colors.background;
  ctx.fill();
  ctx.strokeStyle = colors.border;
  ctx.lineWidth = 1;
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
        PAD_X,
        Math.round(row.y + row.height / 2) + 0.5,
        width - PAD_X * 2,
        1,
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
    label(row.label, color, PAD_X, row);
    if (row.shortcut) {
      // the shortcut column stays quieter than the label, except in the
      // highlighted row where it has to stay legible on the accent
      const shortcutColor = on ? colors.highlightText : colors.dim;
      const layout = layoutOf?.(row.shortcut, shortcutColor);
      const w = layout?.width ?? 0;
      label(row.shortcut, shortcutColor, width - PAD_X - w, row);
    }
  }
}

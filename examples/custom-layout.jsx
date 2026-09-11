// A pinboard: two dozen photos, and four ways to arrange them — three of them
// arrangements flexbox cannot write.
//
//   npm run examples:custom-layout
//
// A box's children are arranged by flexbox unless its style names another
// algorithm: `display: 'grid'` for CSS's grid (docs/styling.md, "Grid"), or
// `layout` for a registered one (docs/styling.md, "Custom layouts"). The
// board here is arranged by one of:
//
//   Masonry          the built-in `masonry`: columns, each pin dropped into
//                    whichever is shortest so far. "Auto" fits as many
//                    200-wide columns as there is room for; a number fixes
//                    the count and the columns share the width.
//   Justified rows   `justified`, registered in this file: rows that each
//                    fill the width, every photo in a row one height and as
//                    wide as its aspect ratio makes it at that height.
//   Grid             `display: 'grid'`, written the way CSS writes it: as
//                    many columns of 200 and up as fit —
//                    `repeat(auto-fill, minmax(200px, 1fr))` — or a count of
//                    equal ones, and rows of one height. A featured pin takes
//                    two columns and two rows, and `gridAutoFlow: 'dense'`
//                    packs the pins after it into the hole it leaves.
//   Flex wrap        flexbox with `flexWrap: 'wrap'`, for comparison: every
//                    row as tall as its tallest pin, with a hole under each
//                    of the others.
//
// The algorithms run inside the frame's layout pass, so nothing here listens
// to a size or measures a pin in an effect, and there is no frame in which a
// pin is drawn somewhere it then moves from.
//
// ## What to try
//
//   Resize          the columns and the rows are worked out again in the
//                   resize's own frames.
//   Feature a pin   click it, or Tab to it and press Space: in the masonry it
//                   spans two columns, in the justified rows it is twice as
//                   wide, in the grid it takes a block two columns wide and
//                   two rows tall — and the rest pack around it.
//   The toolbar     each segmented control is an `equal-row`: every segment
//                   as wide as the widest label. Narrow the window and they
//                   squeeze together — the labels wrap — but never below the
//                   longest word in any of them.
//   LANG=he_IL.UTF-8 npm run examples:custom-layout
//                   everything mirrors: the columns fill from the right and
//                   the rows start at it. None of the algorithms knows; the
//                   core mirrors what they answer.
import React, { useCallback, useState } from 'react';

import { createRoot, createStyles } from '../src/index.js';
import { registerLayout } from '../src/host.js';
import { XK_KP_ENTER, XK_RETURN, XK_SPACE } from '../src/keysyms.js';

const PIN = 200; // a column's narrowest, and a pin's width in the wrap
const GAP = 12;
const ROW_HEIGHTS = { small: 110, medium: 160, large: 220 };

// --- a layout of our own ------------------------------------------------------

// `justified`: the photo gallery's layout. A row takes photos until, at
// `rowHeight`, they would be wider than the box, then scales down until they
// fit it exactly — so every row but the last fills the width, and every photo
// in a row is one height. The last row keeps `rowHeight` rather than blowing
// its photos up to fill.
//
// The algorithm is asked two things with one function: how big the board is
// for the room on offer, and — once the pass has sized it — where each pin
// goes. It never sees a node: `aspect` is what a pin says to the board in its
// `layoutItem`, and the gaps are the board's own `gap`.
registerLayout('justified', {
  options: { rowHeight: { type: 'length', default: 160 } },
  childOptions: { aspect: { type: 'number', default: 1 } },
  layout(children, c, { rowHeight }, { style }) {
    const gap = style.columnGap ?? style.gap ?? 0;
    const rowGap = style.rowGap ?? style.gap ?? 0;
    const aspects = children.map((child) =>
      Math.max(0.1, child.options.aspect),
    );
    // all of them in one row at `rowHeight`: the width the board would like
    const natural =
      aspects.reduce((sum, aspect) => sum + aspect * rowHeight, 0) +
      gap * Math.max(0, children.length - 1);
    const width =
      c.widthMode === 'exactly'
        ? c.width
        : c.widthMode === 'at-most'
          ? Math.min(c.width, natural)
          : natural;

    const rects = [];
    let y = 0;
    let row = [];
    let sum = 0;
    const close = (height) => {
      let x = 0;
      for (const i of row) {
        rects[i] = { x, y, width: aspects[i] * height, height };
        x += aspects[i] * height + gap;
      }
      y += height + rowGap;
      row = [];
      sum = 0;
    };
    for (let i = 0; i < children.length; i++) {
      row.push(i);
      sum += aspects[i];
      // the height at which this row is exactly as wide as the board
      const fill = (width - gap * (row.length - 1)) / sum;
      if (fill <= rowHeight) close(Math.max(0, fill));
    }
    if (row.length) close(rowHeight);
    return {
      width,
      height: c.heightMode === 'exactly' ? c.height : Math.max(0, y - rowGap),
      children: rects,
    };
  },
});

// --- the photos ---------------------------------------------------------------

// width:height, as a camera would say it
const RATIOS = [
  [3, 2],
  [2, 3],
  [1, 1],
  [9, 16],
  [4, 5],
  [4, 3],
  [16, 9],
  [5, 4],
];

const TITLES = [
  'Harbour at dawn',
  'Tram 28',
  'Rooftops after the rain, looking east',
  'Market',
  'The long way round the lighthouse',
  'Fog',
  'Night bus',
  'Ferry terminal, platform four',
  'Lemons',
  'A courtyard nobody uses any more',
  'Kites',
  'Steps',
  'Low tide',
  'The last cable car of the evening',
  'Bakery window',
  'Laundry lines',
  'Cathedral from the river',
  'Swifts',
  'Rain on a tram window',
  'Chess in the park',
  'Salt flats',
  'The old observatory',
  'Neon',
  'Boats pulled up for the winter',
];

const COLORS = [
  '#f59e0b',
  '#3b82f6',
  '#10b981',
  '#ec4899',
  '#8b5cf6',
  '#ef4444',
  '#14b8a6',
  '#6366f1',
  '#84cc16',
  '#f97316',
];

/** The same pins on every run: a title, an aspect ratio and a colour. */
export function buildPins(count = TITLES.length) {
  return Array.from({ length: count }, (_, i) => {
    const [w, h] = RATIOS[(i * 5) % RATIOS.length];
    return {
      id: `p${i}`,
      title: TITLES[i % TITLES.length],
      ratio: `${w}:${h}`,
      aspect: w / h,
      color: COLORS[(i * 3) % COLORS.length],
    };
  });
}

const PINS = buildPins();

// --- the board ----------------------------------------------------------------

const ARRANGEMENTS = [
  { value: 'masonry', label: 'Masonry' },
  { value: 'justified', label: 'Justified rows' },
  { value: 'grid', label: 'Grid' },
  { value: 'wrap', label: 'Flex wrap' },
];

const COLUMNS = [
  { value: 'auto', label: 'Auto' },
  { value: 2, label: '2' },
  { value: 3, label: '3' },
  { value: 4, label: '4' },
];

const HEIGHTS = [
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
];

// What the board is. The arrangement goes on a box inside the scroll pane
// rather than on the pane, which is sized by the window and not by what it
// holds.
function boardStyle(arrangement, columns, rowHeight) {
  switch (arrangement) {
    case 'masonry':
      return [
        s.masonry,
        {
          layout:
            columns === 'auto'
              ? { name: 'masonry', columnWidth: PIN }
              : { name: 'masonry', columns },
        },
      ];
    case 'justified':
      return [
        s.justified,
        { layout: { name: 'justified', rowHeight: ROW_HEIGHTS[rowHeight] } },
      ];
    case 'grid':
      // CSS's own property, flat on the box: "Auto" is the gallery's track
      // list, and a number is that many equal columns
      return [
        s.grid,
        {
          gridTemplateColumns:
            columns === 'auto'
              ? `repeat(auto-fill, minmax(${PIN}px, 1fr))`
              : columns,
        },
      ];
    default:
      return s.wrap;
  }
}

// What a pin says to the board. A registered layout declares the options a
// child may give it, and an option it did not declare is reported, naming
// it; a grid's child places itself with CSS's own `gridColumn` and
// `gridRow`.
function itemStyle(arrangement, pin, featured) {
  switch (arrangement) {
    case 'masonry':
      return { layoutItem: { span: featured ? 2 : 1 } };
    case 'justified':
      return {
        layoutItem: { aspect: featured ? pin.aspect * 2 : pin.aspect },
      };
    case 'grid':
      return featured && s.pinBlock;
    default:
      return { width: featured ? 2 * PIN + GAP : PIN };
  }
}

function pressable(onPress) {
  return {
    role: 'button',
    focusable: true,
    onClick: onPress,
    onKeyDown: (ev) => {
      if (
        ev.keysym === XK_SPACE ||
        ev.keysym === XK_RETURN ||
        ev.keysym === XK_KP_ENTER
      ) {
        ev.preventDefault();
        onPress();
      }
    },
  };
}

function Pin({ pin, arrangement, featured, onToggle }) {
  // In the masonry and the wrap the pin is as wide as it is given and the
  // photo keeps its aspect ratio; in the justified rows and the grid the
  // board names the pin's height as well, and the photo takes what the
  // caption leaves.
  const fills = arrangement === 'justified' || arrangement === 'grid';
  return (
    <box
      {...pressable(() => onToggle(pin.id))}
      aria-pressed={featured}
      aria-label={pin.title}
      data-testname={`pin-${pin.id}`}
      style={[
        s.pin,
        featured && s.pinFeatured,
        itemStyle(arrangement, pin, featured),
      ]}
    >
      <box
        style={[
          s.photo,
          fills ? s.photoFill : { aspectRatio: pin.aspect },
          { backgroundColor: pin.color },
        ]}
      >
        <text style={s.ratio}>{pin.ratio}</text>
      </box>
      <text style={[s.caption, fills && s.captionLine]}>{pin.title}</text>
    </box>
  );
}

function Segmented({ name, label, options, value, onChange }) {
  return (
    <box
      role="radiogroup"
      aria-label={label}
      data-testname={name}
      style={s.segmented}
    >
      {options.map((option) => {
        const on = option.value === value;
        return (
          <box
            key={option.value}
            {...pressable(() => onChange(option.value))}
            role="radio"
            aria-checked={on}
            data-testname={`${name}-${option.value}`}
            style={[s.segment, on && s.segmentOn]}
          >
            <text style={[s.segmentText, on && s.segmentTextOn]}>
              {option.label}
            </text>
          </box>
        );
      })}
    </box>
  );
}

export function PinboardPanel({
  pins = PINS,
  initialArrangement = 'masonry',
  initialFeatured = [],
}) {
  const [arrangement, setArrangement] = useState(initialArrangement);
  const [columns, setColumns] = useState('auto');
  const [rowHeight, setRowHeight] = useState('medium');
  const [featured, setFeatured] = useState(() => new Set(initialFeatured));
  const toggle = useCallback(
    (id) =>
      setFeatured((before) => {
        const after = new Set(before);
        if (!after.delete(id)) after.add(id);
        return after;
      }),
    [],
  );

  return (
    <box style={s.root}>
      <box style={s.toolbar}>
        <box style={s.heading}>
          <text style={s.title}>Pinboard</text>
          <text style={s.subtitle}>
            {pins.length} photos · {featured.size} featured
          </text>
        </box>
        <Segmented
          name="arrangement"
          label="Arrangement"
          options={ARRANGEMENTS}
          value={arrangement}
          onChange={setArrangement}
        />
        {(arrangement === 'masonry' || arrangement === 'grid') && (
          <Segmented
            name="columns"
            label="Columns"
            options={COLUMNS}
            value={columns}
            onChange={setColumns}
          />
        )}
        {arrangement === 'justified' && (
          <Segmented
            name="row-height"
            label="Row height"
            options={HEIGHTS}
            value={rowHeight}
            onChange={setRowHeight}
          />
        )}
      </box>
      <box style={s.pane} data-testname="pane">
        <box
          style={[s.board, boardStyle(arrangement, columns, rowHeight)]}
          data-testname="board"
        >
          {pins.map((pin) => (
            <Pin
              key={pin.id}
              pin={pin}
              arrangement={arrangement}
              featured={featured.has(pin.id)}
              onToggle={toggle}
            />
          ))}
        </box>
      </box>
    </box>
  );
}

const s = createStyles({
  root: { flexGrow: 1, backgroundColor: '$background' },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingStart: 16,
    paddingEnd: 12,
    paddingTop: 10,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderColor: '$border',
  },
  // shrinks to the title's width and no further: the title is one word, and
  // the line under it ellipsizes
  heading: { flexGrow: 1, flexShrink: 1 },
  title: { fontSize: 16, fontWeight: 'bold', color: '$text' },
  subtitle: {
    fontSize: 12,
    color: '$textMuted',
    textWrap: 'nowrap',
    textOverflow: 'ellipsis',
  },

  // A segmented control: `equal-row` makes every segment as wide as the
  // widest. Flexbox makes siblings equal only by dividing a width it was
  // given (`flex: 1`), and a control in a toolbar takes its width from its
  // labels — there is no width to divide.
  segmented: {
    layout: 'equal-row',
    flexShrink: 1,
    gap: 2,
    padding: 2,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '$border',
    backgroundColor: '$surface',
  },
  segment: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingStart: 10,
    paddingEnd: 10,
    paddingTop: 4,
    paddingBottom: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'transparent',
    ':hover': { backgroundColor: '$surfaceHover' },
    ':focus': { borderColor: '$accent' },
  },
  segmentOn: {
    backgroundColor: '$accent',
    ':hover': { backgroundColor: '$accentHover' },
  },
  segmentText: { fontSize: 12, color: '$text', textAlign: 'center' },
  segmentTextOn: { color: '$accentText' },

  pane: { overflow: 'scroll', flexGrow: 1 },
  board: { flexShrink: 0, padding: GAP },
  masonry: { gap: GAP },
  justified: { gap: 6 },
  // The columns change with the toolbar (`boardStyle`); what does not is
  // here: rows of one height, packed densely — a pin placed after a featured
  // one takes the hole the featured one left rather than starting a new row
  // past it
  grid: {
    display: 'grid',
    gridAutoRows: 160,
    gridAutoFlow: 'dense',
    gap: GAP,
  },
  wrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
    gap: GAP,
  },

  pin: {
    overflow: 'hidden',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '$border',
    backgroundColor: '$surface',
    ':focus': { borderColor: '$accent' },
  },
  pinFeatured: { borderWidth: 2, borderColor: '$accent' },
  // a featured pin in the grid: a block two columns wide and two rows tall
  pinBlock: { gridColumn: 'span 2', gridRow: 'span 2' },
  photo: { justifyContent: 'flex-end', padding: 6 },
  photoFill: { flexGrow: 1 },
  ratio: { fontSize: 11, fontWeight: 'bold', color: '#ffffff' },
  caption: {
    fontSize: 12,
    color: '$text',
    paddingStart: 8,
    paddingEnd: 8,
    paddingTop: 6,
    paddingBottom: 6,
  },
  captionLine: { textWrap: 'nowrap', textOverflow: 'ellipsis' },
});

export function App(props) {
  return (
    <window
      width={920}
      height={660}
      minWidth={640}
      minHeight={360}
      title="Pinboard — layouts"
      style={{ backgroundColor: '$background' }}
    >
      <PinboardPanel {...props} />
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN && !import.meta.hot) {
  const root = await createRoot();
  root.render(<App />);
}

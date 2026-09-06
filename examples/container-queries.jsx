// Container queries: a style asking about the box it is inside, rather than
// the window it is in. One <Card> component is rendered in a narrow sidebar
// and in the main pane, and lays itself out for the pane it landed in — drag
// the divider and both sides answer, while the window stays where it is.
//
// Three kinds of query in one file, so the difference between them shows:
//
//   '@width < 720'                   the window — a size query
//                                    (docs/styling.md#window-size-queries)
//   '@container width >= 380'        the nearest container above the node;
//                                    each pane declares itself one, and so
//                                    does each card, for its own contents
//   '@container pane width >= 300'   a container by name, reaching past the
//                                    card's own container to the pane's
//
// Run with: npm run examples:container-queries  (needs an X server / DISPLAY)
import React, { useState } from 'react';
import { createRoot, createStyles, SplitPane } from '../src/index.js';

const s = createStyles({
  root: { flexGrow: 1, backgroundColor: '$background' },
  header: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 12,
    paddingLeft: 16,
    paddingRight: 16,
    paddingTop: 12,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderColor: '$border',
  },
  heading: { fontSize: 16, color: '$text' },
  // the explanation is the window's business: it goes when the window is
  // too narrow to hold it beside the heading
  hint: {
    fontSize: 12,
    color: '$textMuted',
    '@width < 720': { display: 'none' },
  },
  // Each pane is a container, and a scroller — which is the natural thing to
  // make a container: its size is what the layout gives it and its content
  // overflows rather than grows it, so nothing a card does can move the
  // size the cards are asking about. Both panes carry the same name, so a
  // block that says "pane" finds whichever pane it is in.
  pane: {
    container: 'pane',
    flexGrow: 1,
    minWidth: 0,
    overflow: 'scroll',
    padding: 12,
    gap: 12,
  },
  paneTitle: { fontSize: 11, color: '$textMuted' },
  // A card: stacked when its pane is narrow, a row once the pane has room.
  // The nearest container above a card is the pane, so this asks the pane —
  // and the card declares itself a container too, for what is inside it.
  card: {
    container: true,
    flexDirection: 'column',
    gap: 10,
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '$border',
    backgroundColor: '$surface',
    '@container width >= 380': {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 14,
    },
  },
  thumb: {
    width: 44,
    height: 44,
    borderRadius: 8,
    flexShrink: 0,
    '@container width >= 380': { width: 60, height: 60 },
  },
  body: { flexGrow: 1, minWidth: 0, gap: 4 },
  title: { fontSize: 14, color: '$text' },
  // the card's own width: the nearest container above this line is the
  // card, so a card squeezed under 220 drops its detail before its title
  // has to wrap
  detail: {
    fontSize: 12,
    color: '$textMuted',
    '@container width < 220': { display: 'none' },
  },
  toolbar: { flexDirection: 'row', gap: 6, flexShrink: 0 },
  tool: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingLeft: 8,
    paddingRight: 8,
    paddingTop: 4,
    paddingBottom: 4,
    borderRadius: 6,
    backgroundColor: '$surfaceHover',
    cursor: 'pointer',
    transition: { backgroundColor: 120 },
    ':hover': { backgroundColor: '$track' },
    ':active': { backgroundColor: '$surfaceActive' },
  },
  glyph: { fontSize: 13, color: '$text' },
  // The label reaches past the card — the nearest container — to the pane,
  // by name: icon-only tools in a narrow pane, labelled ones in a wide one,
  // whatever the card's own width happens to be.
  label: {
    fontSize: 12,
    color: '$text',
    display: 'none',
    '@container pane width >= 300': { display: 'flex' },
  },
});

const ITEMS = [
  {
    title: 'Quarterly review',
    detail: 'Slides, notes and the recording — 14 files',
    color: '#2980b9',
  },
  {
    title: 'Kitchen renovation',
    detail: 'Quotes from three builders, floor plan v3',
    color: '#27ae60',
  },
  {
    title: 'Reading list',
    detail: 'Twelve unread, two in progress',
    color: '#e67e22',
  },
  {
    title: 'Trip to Lisbon',
    detail: 'Flights booked, hotel still to confirm',
    color: '#8e44ad',
  },
];

const TOOLS = [
  ['+', 'Add'],
  ['→', 'Share'],
  ['…', 'More'],
];

function Card({ item }) {
  return (
    <box style={s.card}>
      <box style={[s.thumb, { backgroundColor: item.color }]} />
      <box style={s.body}>
        <text style={s.title}>{item.title}</text>
        <text style={s.detail}>{item.detail}</text>
      </box>
      <box style={s.toolbar}>
        {TOOLS.map(([glyph, name]) => (
          <box
            key={name}
            style={s.tool}
            focusable
            role="button"
            aria-label={name}
          >
            <text style={s.glyph}>{glyph}</text>
            <text style={s.label}>{name}</text>
          </box>
        ))}
      </box>
    </box>
  );
}

function Pane({ name, items }) {
  // `onLayout` is the React-side seam: the same width the blocks compare
  // against, for a decision that is not a style — here, only a caption
  const [width, setWidth] = useState(null);
  return (
    <box style={s.pane} onLayout={(ev) => setWidth(Math.round(ev.width))}>
      <text style={s.paneTitle}>
        {name}
        {width == null ? '' : ` · ${width}px`}
      </text>
      {items.map((item) => (
        <Card key={item.title} item={item} />
      ))}
    </box>
  );
}

export default function App({ sidebar: initial = 260 }) {
  const [sidebar, setSidebar] = useState(initial);
  return (
    <window
      title="container queries"
      width={900}
      height={520}
      minWidth={480}
      minHeight={320}
      style={s.root}
    >
      <box style={s.header}>
        <text style={s.heading}>Container queries</text>
        <text style={s.hint}>
          drag the divider — each card answers to its pane, not to the window
        </text>
      </box>
      <SplitPane
        direction="row"
        size={sidebar}
        onResize={setSidebar}
        min={160}
        minSecond={240}
      >
        <Pane name="sidebar" items={ITEMS.slice(0, 3)} />
        <Pane name="main" items={ITEMS} />
      </SplitPane>
    </window>
  );
}

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<App />);
}

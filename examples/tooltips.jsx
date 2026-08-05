// Tooltips: the two kinds, and where they point.
//
// A `label` that is a **string** is measured and the popup is sized around
// it — the common case, and the one that needs nothing from the caller. A
// `label` that is an **element** gets the bubble to fill and a `width`/
// `height` to fill it at, because a <popup> is a real X window: it needs its
// size before React can lay anything out inside it. Anything renders in
// there, widgets included — the last card below has a real <ProgressBar>.
//
// `direction` picks the side. The default, `"auto"`, takes the first side
// the hint fits on measured against the *screen* (a popup is a real window,
// so the screen is what bounds it) — drag this window to the top edge and
// the hints that were opening above start opening below.
//
// Where a compositor is running the popups are ARGB windows: rounded
// corners, and a small arrow pointing back at the trigger with the rest of
// the window left transparent. Without one they degrade to the square
// opaque rectangles they have always been — the strip below says which of
// the two this display is getting.
//
// Run with: npm run examples:tooltips  (needs an X server / DISPLAY)
import React, { useState } from 'react';
import {
  createRoot,
  Button,
  ProgressBar,
  Tooltip,
  useSupports,
} from '../src/index.js';

const INK = '#2d3436';
const DIM = '#7f8c8d';

const SWATCHES = [
  { name: 'Signal', hex: '#e74c3c', use: 'errors, destructive actions' },
  { name: 'Meadow', hex: '#27ae60', use: 'success, "saved" states' },
  { name: 'Harbour', hex: '#2980b9', use: 'selection, links, focus' },
];

/**
 * A tooltip that is a component rather than a line of text: a chip of the
 * colour, its name and hex, and a note under them.
 *
 * `flexGrow: 1` because the bubble hands an element the whole rectangle and
 * imposes no padding of its own — the card draws its own, which is the
 * point of passing one.
 */
function SwatchCard({ swatch }) {
  return (
    <box style={{ flexGrow: 1, padding: 10, gap: 8 }}>
      <box style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <box
          style={{
            width: 22,
            height: 22,
            borderRadius: 5,
            backgroundColor: swatch.hex,
          }}
        />
        <box style={{ gap: 1 }}>
          <text style={{ color: '#f5f6fa', fontSize: 13 }}>{swatch.name}</text>
          <text style={{ color: '#b2bec3', fontSize: 11 }}>{swatch.hex}</text>
        </box>
      </box>
      <text style={{ color: '#b2bec3', fontSize: 11 }}>{swatch.use}</text>
    </box>
  );
}

/** And one with a live widget in it, to make the point that it is a real
 *  tree and not a rich-text label. */
function UsageCard({ used }) {
  return (
    <box style={{ flexGrow: 1, padding: 10, gap: 7, justifyContent: 'center' }}>
      <text style={{ color: '#f5f6fa', fontSize: 13 }}>Scratch volume</text>
      <ProgressBar value={used} />
      <text style={{ color: '#b2bec3', fontSize: 11 }}>
        {`${Math.round(used * 100)}% of 240 GB used`}
      </text>
    </box>
  );
}

function Row({ label, children }) {
  return (
    <box style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <text style={{ color: DIM, width: 92 }}>{label}</text>
      {children}
    </box>
  );
}

function Panel() {
  const [used, setUsed] = useState(0.62);
  const composited = useSupports('transparency');

  return (
    <box style={{ flexGrow: 1, padding: 18, gap: 16 }}>
      <box style={{ gap: 3 }}>
        <text style={{ fontSize: 19, color: INK }}>Tooltips</text>
        <text style={{ fontSize: 12, color: DIM }}>
          {composited
            ? 'compositing: rounded, with an arrow'
            : 'no compositor: square and opaque, no arrow'}
        </text>
      </box>

      {/* A string label. Nothing to size, nothing to lay out — the popup is
          measured from the text. */}
      <Row label="Text">
        <Tooltip label="Back to zero" delay={250}>
          <Button onPress={() => setUsed(0)}>Reset</Button>
        </Tooltip>
        <Tooltip label="Fills the volume up" direction="bottom" delay={250}>
          <Button onPress={() => setUsed((u) => Math.min(1, u + 0.12))}>
            Fill
          </Button>
        </Tooltip>
        <Tooltip
          label="Hangs off the right, where there is room for it"
          direction="right"
          delay={250}
        >
          <Button>Right</Button>
        </Tooltip>
      </Row>

      {/* An element label: the caller says how big, and fills it. */}
      <Row label="Component">
        {SWATCHES.map((swatch) => (
          <Tooltip
            key={swatch.hex}
            label={<SwatchCard swatch={swatch} />}
            width={190}
            height={78}
            delay={250}
          >
            <box
              style={{
                width: 54,
                height: 34,
                borderRadius: 6,
                borderWidth: 1,
                borderColor: '#dfe6e9',
                backgroundColor: swatch.hex,
                cursor: 'pointer',
              }}
            />
          </Tooltip>
        ))}
      </Row>

      <Row label="Widgets">
        <Tooltip
          label={<UsageCard used={used} />}
          width={200}
          height={82}
          direction="right"
          delay={250}
        >
          <box
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              paddingTop: 7,
              paddingBottom: 7,
              paddingLeft: 12,
              paddingRight: 12,
              borderRadius: 6,
              borderWidth: 1,
              borderColor: '#dfe6e9',
              backgroundColor: 'white',
              cursor: 'pointer',
            }}
          >
            <text style={{ color: INK }}>/scratch</text>
            <text style={{ color: DIM, fontSize: 12 }}>
              {`${Math.round(used * 100)}%`}
            </text>
          </box>
        </Tooltip>
      </Row>

      <box style={{ flexGrow: 1 }} />
      <text style={{ fontSize: 11, color: DIM }}>
        Move the window against a screen edge to watch “auto” change its mind.
      </text>
    </box>
  );
}

function App() {
  return (
    <window
      width={520}
      height={330}
      title="tooltips"
      style={{ backgroundColor: '#f5f6fa' }}
    >
      <Panel />
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<App />);
}

// Attention: which box is the pointer heading for, said before it gets there.
//
// Move the pointer across the window and watch a box light up *ahead* of the
// cursor. That is `unstable_onAttention` plus an `:attention` style block —
// prototype for ntk#37, and the thing this example exists to make visible,
// because a prediction is very hard to believe from a test.
//
// Three things are worth watching for, and the layout is arranged to show
// each of them:
//
//   - **Direction beats distance.** Sweep left-to-right along the middle row
//     and the box you are moving *towards* lights up while a nearer box
//     behind you stays dark. Sweep back and it reverses.
//   - **Only one box at a time.** Attention is a single node per window, so
//     the previous holder gives it up as the new one takes it. Each box also
//     keeps a count of how many times it has been picked, in React state, so
//     you can see the handovers accumulate.
//   - **Overlap and absolute positioning are not special.** The stacked pair
//     on the right overlaps; the two loose boxes are `position: 'absolute'`.
//     Nothing is hit tested here — a box wins by being the first rectangle
//     the trajectory would enter — so stacking order does not decide it, and
//     a box the pointer never touches can still be picked.
//
// The `eta` on the event is the useful part in a real application: it is
// roughly how many milliseconds away the pointer is, which is what tells you
// whether it is worth starting anything. Each box prints its own.
//
// This file is the only documentation the feature has, deliberately. It is a
// prototype and the shape may not survive — the tuning is uncalibrated, and
// whether the handler earns its keep depends on there being work worth
// starting early — so it stays out of `docs/` until that is settled, rather
// than being announced and then depended on.
//
// Run with: npm run examples:attention  (needs an X server / DISPLAY)
import React, { useCallback, useRef, useState } from 'react';
import { createRoot } from '../src/index.js';

const INK = '#dcdde1';
const DIM = '#7f8c9b';

/**
 * One box. `:attention` does the paint, so the visual costs no React render
 * at all — it is a repaint of one node, the same as `:hover`.
 *
 * The handler is here to show the other half: in a real application this is
 * where a cache is warmed or a request goes out. Setting React state from it,
 * as this does, is the *expensive* way to react to attention and is done here
 * only because the counter is the point.
 */
function Box({ label, hue, style }) {
  const [picks, setPicks] = useState(0);
  const [eta, setEta] = useState(null);
  const onAttention = useCallback((ev) => {
    setPicks((n) => n + 1);
    setEta(ev.eta);
  }, []);

  return (
    <box
      unstable_onAttention={onAttention}
      style={{
        padding: 10,
        gap: 2,
        borderRadius: 6,
        borderWidth: 2,
        borderColor: 'transparent',
        backgroundColor: hue,
        transition: { borderColor: 90, backgroundColor: 90 },
        // the prediction…
        ':attention': { borderColor: '#f5f6fa' },
        // …and the fact, which outranks it once the pointer really lands
        ':hover': { borderColor: '#f5f6fa', backgroundColor: '#5c6bc0' },
        ...style,
      }}
    >
      <text style={{ fontSize: 13, color: INK }}>{label}</text>
      <text style={{ fontSize: 11, color: DIM }}>
        {picks === 0 ? 'not yet' : `picked ${picks}×`}
      </text>
      <text style={{ fontSize: 11, color: DIM }}>
        {eta === null ? ' ' : `~${eta}ms away`}
      </text>
    </box>
  );
}

function App() {
  // Where the pointer is and which way it is going, so the prediction can be
  // read against it — in a still screenshot this is the only thing that says
  // *why* a particular box lit up. `useRef` for the previous sample so the
  // arrow costs no extra render.
  const [pointer, setPointer] = useState(null);
  const last = useRef(null);
  const onMouseMove = useCallback((ev) => {
    const previous = last.current;
    const heading =
      previous && Math.abs(ev.x - previous.x) > 2
        ? ev.x > previous.x
          ? '→'
          : '←'
        : (previous?.heading ?? '·');
    last.current = { x: ev.x, y: ev.y, heading };
    setPointer({ x: Math.round(ev.x), y: Math.round(ev.y), heading });
  }, []);

  return (
    <window
      title="Attention"
      width={780}
      height={460}
      onMouseMove={onMouseMove}
      style={{ backgroundColor: '#2f3640', padding: 18, gap: 14 }}
    >
      <text style={{ fontSize: 15, color: INK }}>
        Move the pointer around. A box lights up before you reach it.
      </text>
      <box style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
        <text style={{ fontSize: 12, color: DIM }}>
          Sweep along a row: the box ahead of you is picked, the one behind is
          not.
        </text>
        <text style={{ fontSize: 12, color: INK }}>
          {pointer
            ? `pointer ${pointer.heading} at ${pointer.x},${pointer.y}`
            : 'pointer —'}
        </text>
      </box>

      {/* The middle row — the direction demonstration. Wide gaps so there is
          room to build up speed between them. */}
      <box style={{ flexDirection: 'row', gap: 40, marginTop: 8 }}>
        <Box label="one" hue="#3d4451" />
        <Box label="two" hue="#44506b" />
        <Box label="three" hue="#3d4451" />
        <Box label="four" hue="#44506b" />
      </box>

      {/* Overlapping pair: `over` sits on top of `under`, but `under` reaches
          further left, so a pointer arriving from the left is predicted into
          `under` first — entry order, not stacking order. */}
      <box style={{ height: 150, marginTop: 6 }}>
        <Box
          label="under"
          hue="#4a3f55"
          style={{
            position: 'absolute',
            left: 20,
            top: 10,
            width: 220,
            height: 110,
          }}
        />
        <Box
          label="over"
          hue="#5b4a63"
          style={{
            position: 'absolute',
            left: 150,
            top: 40,
            width: 150,
            height: 90,
            zIndex: 1,
          }}
        />

        {/* Loose absolutely-positioned boxes, off on their own. Nothing
            contains them and nothing routes to them; they are candidates
            because they said so. */}
        <Box
          label="adrift"
          hue="#3f5548"
          style={{
            position: 'absolute',
            left: 400,
            top: 0,
            width: 130,
            height: 70,
          }}
        />
        <Box
          label="corner"
          hue="#55503f"
          style={{
            position: 'absolute',
            left: 580,
            top: 60,
            width: 140,
            height: 80,
          }}
        />
      </box>

      <text style={{ fontSize: 11, color: DIM, marginTop: 'auto' }}>
        A white border is the prediction; landing on a box turns it indigo.
      </text>
    </window>
  );
}

const root = await createRoot();
root.render(<App />);

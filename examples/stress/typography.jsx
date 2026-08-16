// Text correctness: the same paragraph set in every combination the style
// channel offers, so the faces and metrics can be compared by eye.
//
// What to look for:
//   - wrapping at the column edge, not one word early or late
//   - `lineHeight` spacing the lines without clipping ascenders/descenders
//   - italic and bold actually resolving to different faces (they fall back
//     to the regular face when the font source has no such variant — that is
//     a font problem, not a layout one)
//   - the bidi line reading right-to-left with the Latin word left-to-right
//     inside it, and its punctuation on the correct end
import React, { useState } from 'react';
import { createStyles, Slider } from '../../src/index.js';

const s = createStyles({
  panel: { flexGrow: 1, minHeight: 0, padding: 16, gap: 12 },
  head: { fontSize: 18, color: '$text' },
  hint: { fontSize: 11, color: '$textMuted' },
  row: { flexDirection: 'row', gap: 16, alignItems: 'flex-start' },
  col: { flexGrow: 1, flexBasis: 0, minWidth: 0, gap: 8 },
  card: {
    backgroundColor: '$background',
    borderWidth: 1,
    borderColor: '$track',
    borderRadius: 4,
    padding: 12,
    gap: 6,
  },
  label: { fontSize: 10, color: '$border' },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flexShrink: 0,
  },
});

const LOREM =
  'Typography is the craft of arranging type to make written language ' +
  'legible, readable and appealing when displayed. The arrangement ' +
  'involves selecting typefaces, point sizes, line lengths and the ' +
  'spaces between pairs of letters.';

// One paragraph per style axis, so a regression shows up as one wrong card
// rather than as a page that looks vaguely off.
const VARIANTS = [
  { label: 'regular 13', style: { fontSize: 13 } },
  { label: 'bold 13', style: { fontSize: 13, fontWeight: 700 } },
  { label: 'italic 13', style: { fontSize: 13, fontStyle: 'italic' } },
  {
    label: 'bold italic 13',
    style: { fontSize: 13, fontWeight: 700, fontStyle: 'italic' },
  },
  { label: 'monospace 12', style: { fontSize: 12, fontFamily: 'monospace' } },
  { label: 'lineHeight 1.8', style: { fontSize: 13, lineHeight: 1.8 } },
  // 0.75 rather than 0.9: the multiplier applies to the font's natural line
  // height, so a 10% reduction is about 1.5px per line and reads as a
  // rendering wobble rather than as a setting doing something.
  {
    label: 'lineHeight 0.75 (tight)',
    style: { fontSize: 13, lineHeight: 0.75 },
  },
  { label: 'centered', style: { fontSize: 13, textAlign: 'center' } },
  { label: 'right', style: { fontSize: 13, textAlign: 'right' } },
  { label: 'dim colour', style: { fontSize: 13, color: '#95a5a6' } },
];

// Bidi: Hebrew with an embedded Latin word. The Latin runs LTR inside an RTL
// paragraph, and the full stop belongs at the *left* end of the line.
const BIDI = 'הטקסט הזה נכתב בעברית עם המילה react באמצע.';

export function TypographyPanel() {
  const [size, setSize] = useState(13);
  const [width, setWidth] = useState(100);

  return (
    <box style={[s.panel, { overflow: 'scroll' }]}>
      <text style={s.head}>Typography</text>
      <text style={s.hint}>
        Every style axis on the same paragraph. The sliders resize and re-column
        everything, which is the interesting case for layout: a width change
        invalidates every measure function at once.
      </text>

      <box style={s.controls}>
        <text style={s.hint}>size {String(size)}</text>
        <Slider
          value={size}
          min={8}
          max={28}
          onChange={(ev) => setSize(ev.value)}
          style={{ width: 120 }}
        />
        <text style={s.hint}>column {String(width)}%</text>
        <Slider
          value={width}
          min={40}
          max={100}
          onChange={(ev) => setWidth(ev.value)}
          style={{ width: 120 }}
        />
      </box>

      <box style={{ width: `${width}%`, gap: 12 }}>
        <box style={s.row}>
          <box style={s.col}>
            {VARIANTS.filter((_, i) => i % 2 === 0).map((v) => (
              <box key={v.label} style={s.card}>
                <text style={s.label}>{v.label}</text>
                <text
                  style={{ ...v.style, fontSize: v.style.fontSize + size - 13 }}
                >
                  {LOREM}
                </text>
              </box>
            ))}
          </box>
          <box style={s.col}>
            {VARIANTS.filter((_, i) => i % 2 === 1).map((v) => (
              <box key={v.label} style={s.card}>
                <text style={s.label}>{v.label}</text>
                <text
                  style={{ ...v.style, fontSize: v.style.fontSize + size - 13 }}
                >
                  {LOREM}
                </text>
              </box>
            ))}
          </box>
        </box>

        <box style={s.card}>
          <text style={s.label}>bidi — RTL paragraph with an LTR word</text>
          <text style={{ fontSize: size, textAlign: 'right' }}>{BIDI}</text>
        </box>

        <box style={s.card}>
          <text style={s.label}>
            inline spans — one &lt;text&gt;, many styles
          </text>
          {/* nested <text> are spans: one layout, several styles, so the
              baseline must stay continuous across them */}
          <text style={{ fontSize: size }}>
            A single text node with{' '}
            <text style={{ fontWeight: 700 }}>bold</text>,{' '}
            <text style={{ fontStyle: 'italic' }}>italic</text>,{' '}
            <text style={{ color: '#0984e3' }}>coloured</text> and{' '}
            <text style={{ fontFamily: 'monospace', fontSize: size - 1 }}>
              monospace
            </text>{' '}
            spans, which all share one baseline.
          </text>
        </box>
      </box>
    </box>
  );
}

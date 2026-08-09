// A variable-font lab: pick a font file, and the app builds a control per
// axis the file actually has — read off the font, not configured here.
//
//   Select font…  ->  useFileDialog()      the desktop's own dialog
//   app.fonts.load(path)                   register it at runtime
//   font.variationAxes                     { wght: {name, min, default, max} }
//   font.fk.namedVariations                the designer's chosen points
//
// A slider per continuous axis, a Switch for a binary one, a readout for an
// axis pinned to a single value, and a Select for the named instances. The
// panel at the bottom prints the `<text>` that would draw what you are
// looking at — the point being that `wght` comes out as `fontWeight`, since
// that is the axis react-x11 already drives, and everything else goes in
// `fontVariationSettings`.
//
// The specimen also carries `textRendering: 'geometricPrecision'`, scoped to
// that one <text>: it takes the precise glyph path while every control
// around it keeps its glyph cache. See the note above the constant.
//
// Needs a variable font to be interesting. Most systems have one:
//   /usr/share/fonts/truetype/ubuntu/Ubuntu[wdth,wght].ttf   (wdth + wght)
// Pick a .ttf/.otf rather than a .woff2 — fontkit cannot instantiate an axis
// out of a compressed font, and the app says so when you try.
//
// Run with: npm run examples:variable-fonts  (needs an X server / DISPLAY)
import React, { useCallback, useMemo, useState } from 'react';
import { Font } from 'ntk';

import {
  Button,
  Select,
  Slider,
  Switch,
  createRoot,
  createStyles,
  useApp,
  useFileDialog,
} from '../src/index.js';

// Every distinct coordinate is a font in its own right — its own glyphs, its
// own server-side glyphset — so the control is stepped rather than the font
// quantized (which is ntk's advice, and the reason it does not do it for
// you). A coarse grid on a wide axis, a fine one on a narrow one.
function stepFor(axis) {
  const range = axis.max - axis.min;
  if (range > 400) return 10;
  if (range > 40) return 5;
  if (range > 4) return 1;
  return 0.1;
}

/** An axis of 0..1 is the `ital` convention: a switch, not a slider. */
const isBinary = (axis) => axis.min === 0 && axis.max === 1;

/**
 * ntk draws each run through one of two glyph paths:
 *
 * - **cached bitmaps** — each glyph rasterizes once, uploads to a
 *   server-side glyphset and composites by id. Cheap to redraw, and every
 *   advance is baked in as a **whole number**, because a cached bitmap can
 *   only land on a whole pixel.
 * - **outlines** — flattened at the exact size, trapezoidated and
 *   composited through a scratch mask, every draw. Nothing is cached, and
 *   positions are deliberately not rounded.
 *
 * By default the size decides, which is right for UI text and wrong for the
 * specimen above it: slide the `wght` slider and the true advances move by
 * hundredths of a pixel, which the cached path cannot express. They
 * accumulate along the line until one glyph crosses a rounding boundary and
 * jumps a whole pixel by itself while its neighbours stand still.
 *
 * `textRendering` is how a `<text>` says which it wants, and it is scoped to
 * that element rather than to the app — which is the whole reason it is a
 * style prop. The specimen asks for outlines; every label, value and hint
 * around it says nothing and keeps its glyph cache.
 */
const SPECIMEN_RENDERING = 'geometricPrecision';

/** Axis order: the ones people reach for first, then whatever else exists. */
const AXIS_ORDER = ['wght', 'wdth', 'opsz', 'slnt', 'ital', 'GRAD'];
const byFamiliarity = (a, b) => {
  const ia = AXIS_ORDER.indexOf(a);
  const ib = AXIS_ORDER.indexOf(b);
  return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
};

const s = createStyles({
  window: { backgroundColor: '$background' },
  page: { flexGrow: 1, padding: 20, gap: 18 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  title: { fontSize: 16, fontWeight: 600, color: '$text' },
  spacer: { flexGrow: 1 },
  dim: { fontSize: 12, color: '$dim' },
  card: {
    backgroundColor: '$surfaceHover',
    borderWidth: 1,
    borderColor: '$border',
    borderRadius: 6,
    padding: 16,
    gap: 12,
  },
  sample: { minHeight: 90, justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  axisName: { width: 150 },
  axisTag: { fontSize: 13, color: '$text', fontWeight: 500 },
  axisLabel: { fontSize: 11, color: '$dim' },
  value: { width: 58, fontSize: 13, color: '$text' },
  range: { width: 96, fontSize: 11, color: '$dim' },
  code: {
    backgroundColor: '$background',
    borderWidth: 1,
    borderColor: '$border',
    borderRadius: 6,
    padding: 14,
  },
  codeText: { fontFamily: 'monospace', fontSize: 12, lineHeight: 1.5 },
  warn: { fontSize: 12, color: '#c0392b', lineHeight: 1.45 },
  empty: { gap: 8, paddingTop: 40, alignItems: 'center' },
});

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * What the app knows about a picked file. `axes` is read straight off the
 * font — this is the whole of "what can I move?", and a static face answers
 * with `{}` rather than with an error.
 */
function inspect(path, family) {
  const font = Font.loadSync(path);
  const axes = font.variationAxes;
  const named = font.fk.namedVariations ?? {};
  let instancing = null; // an error message, when the axes cannot be cut
  const first = Object.keys(axes)[0];
  if (first) {
    try {
      // a variable .woff2 parses and reports axes and then cannot be
      // instantiated; better to find out here than at the first keystroke
      font.variation({ [first]: axes[first].max });
    } catch (err) {
      instancing = err.message;
    }
  }
  return {
    path,
    family,
    file: path.split('/').pop(),
    name: font.familyName ?? '(unnamed)',
    axes,
    named: Object.keys(named).length ? named : null,
    namedCoords: named,
    instancing,
  };
}

let loaded = 0; // unique family counter, so picks never collide

const defaults = (axes) =>
  Object.fromEntries(Object.entries(axes).map(([tag, a]) => [tag, a.default]));

// ---------------------------------------------------------------------------
// The code panel
// ---------------------------------------------------------------------------

const num = (v) =>
  Number.isInteger(v) ? String(v) : String(Number(v.toFixed(2)));

/**
 * The `<text>` that would draw what is on screen.
 *
 * `wght` is deliberately not in `fontVariationSettings`: `fontWeight` drives
 * that axis, which is the thing worth teaching — an app with a variable font
 * and one weight prop needs nothing else.
 */
function snippetFor({ font, size, values, sample }) {
  // The family printed is the font's own, not the private alias this app
  // registers it under — the snippet is meant to be read and copied, and a
  // `picked-3` in it would be a lie about how the font got there. The line
  // above it is how it got there.
  const family = font.label;
  const lines = [
    `// app.fonts.load('${font.file}', { family: '${family}' })`,
    '<text',
    '  style={{',
  ];
  lines.push(`    fontFamily: '${family}',`);
  lines.push(`    fontSize: ${num(size)},`);
  if (font.axes.wght) lines.push(`    fontWeight: ${num(values.wght)},`);
  const others = Object.keys(font.axes)
    .filter((tag) => tag !== 'wght')
    .sort(byFamiliarity);
  if (others.length) {
    const pairs = others.map((tag) => `${tag}: ${num(values[tag])}`).join(', ');
    lines.push(`    fontVariationSettings: { ${pairs} },`);
  }
  lines.push(`    textRendering: '${SPECIMEN_RENDERING}',`);
  lines.push('  }}', '>', `  ${sample}`, '</text>');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function AxisRow({ tag, axis, value, onChange }) {
  const fixed = axis.min === axis.max;
  return (
    <box style={s.row}>
      <box style={s.axisName}>
        <text style={s.axisTag}>
          {tag}
          {tag === 'wght' ? ' → fontWeight' : ''}
        </text>
        <text style={s.axisLabel}>{axis.name ?? tag}</text>
      </box>
      <text style={s.value}>{num(value)}</text>
      <text style={s.range}>
        {fixed ? 'fixed' : `${num(axis.min)}–${num(axis.max)}`}
      </text>
      {fixed ? (
        <text style={s.dim}>this face pins the axis</text>
      ) : isBinary(axis) ? (
        <Switch
          checked={value >= 0.5}
          onChange={(ev) => onChange(ev.value ? 1 : 0)}
        />
      ) : (
        <Slider
          value={value}
          min={axis.min}
          max={axis.max}
          step={stepFor(axis)}
          onChange={(ev) => onChange(ev.value)}
          style={{ flexGrow: 1, minWidth: 120 }}
        />
      )}
    </box>
  );
}

// ---------------------------------------------------------------------------

function Lab({ initialFont = null }) {
  const app = useApp();
  const { openFile } = useFileDialog();
  const [font, setFont] = useState(null);
  const [error, setError] = useState(null);
  const [values, setValues] = useState({});
  const [size, setSize] = useState(64);
  const [sample, setSample] = useState('Handgloves');
  const [picked, setPicked] = useState(null); // the named instance, if any

  /** Register a file with the running app and read its axes off it. */
  const load = useCallback(
    (path) => {
      try {
        // a fresh family per pick, so a second font never resolves to the
        // first: `fonts.load` registers by family, and two files claiming
        // "Ubuntu" would otherwise be one family with two faces
        const family = `picked-${++loaded}`;
        const info = inspect(path, family);
        app.fonts.load(path, { family });
        setFont({ ...info, name: family, label: info.name });
        setValues(defaults(info.axes));
        setPicked(null);
        setError(null);
      } catch (err) {
        setFont(null);
        setError(err.message);
      }
    },
    [app],
  );

  // a path on the command line preloads, so the app can be pointed straight
  // at a face: `npm run examples:variable-fonts -- /path/to/Font.ttf`
  const [booted, setBooted] = useState(false);
  if (initialFont && !booted) {
    setBooted(true);
    load(initialFont);
  }

  const pick = useCallback(async () => {
    const files = await openFile({
      title: 'Select a font',
      filters: [
        { name: 'Fonts', extensions: ['ttf', 'otf', 'ttc', 'woff', 'woff2'] },
      ],
    });
    if (!files?.length) return; // cancelled — an outcome, not an error
    load(files[0]);
  }, [openFile, load]);

  const tags = useMemo(
    () => Object.keys(font?.axes ?? {}).sort(byFamiliarity),
    [font],
  );

  const namedNames = useMemo(() => Object.keys(font?.named ?? {}), [font]);

  // `wght` is spent on fontWeight; everything else is fontVariationSettings
  const variations = useMemo(() => {
    const out = {};
    for (const tag of tags) if (tag !== 'wght') out[tag] = values[tag];
    return Object.keys(out).length ? out : undefined;
  }, [tags, values]);

  const setAxis = (tag, value) => {
    setValues((v) => ({ ...v, [tag]: value }));
    setPicked(null); // it is no longer that named instance
  };

  const applyNamed = (name) => {
    setPicked(name);
    const coords = font.namedCoords[name];
    if (coords) setValues((v) => ({ ...v, ...coords }));
  };

  return (
    <window
      title="react-x11 — variable fonts"
      width={860}
      height={760}
      style={s.window}
    >
      <box style={{ overflow: 'scroll', flexGrow: 1 }}>
        <box style={s.page}>
          <box style={s.header}>
            <text style={s.title}>Variable font lab</text>
            <box style={s.spacer} />
            {font && (
              <text style={s.dim}>
                {font.label} · {font.file}
              </text>
            )}
            <Button label="Select font…" primary onPress={pick} />
          </box>

          {error && <text style={s.warn}>{error}</text>}

          {!font && !error && (
            <box style={s.empty}>
              <text style={{ fontSize: 14, color: '$text' }}>
                Pick a font file to see its axes.
              </text>
              <text style={s.dim}>
                A variable .ttf has them; a static face reports none. On most
                Linux boxes:
                /usr/share/fonts/truetype/ubuntu/Ubuntu[wdth,wght].ttf
              </text>
            </box>
          )}

          {font && (
            <>
              <box style={[s.card, s.sample]}>
                <text
                  style={{
                    fontFamily: font.name,
                    fontSize: size,
                    fontWeight: font.axes.wght ? values.wght : undefined,
                    fontVariationSettings: variations,
                    // 'geometricPrecision' — the only element in the window
                    // that says so. The controls below never mention it, so
                    // they keep the cached glyph path this one opts out of.
                    // Shared with the snippet panel, which prints what this
                    // is actually styled with rather than a copy of it.
                    textRendering: SPECIMEN_RENDERING,
                    color: '$text',
                  }}
                >
                  {sample}
                </text>
              </box>

              {font.instancing && <text style={s.warn}>{font.instancing}</text>}

              <box style={s.card}>
                <box style={s.row}>
                  <box style={s.axisName}>
                    <text style={s.axisTag}>sample</text>
                    <text style={s.axisLabel}>type to change it</text>
                  </box>
                  <textinput
                    value={sample}
                    onChange={(ev) => setSample(ev.value)}
                    style={{ flexGrow: 1 }}
                  />
                </box>

                <box style={s.row}>
                  <box style={s.axisName}>
                    <text style={s.axisTag}>size → fontSize</text>
                    <text style={s.axisLabel}>not an axis; px</text>
                  </box>
                  <text style={s.value}>{num(size)}</text>
                  <text style={s.range}>8–200</text>
                  {/* half-pixel steps: the specimen is on the precise glyph
                      path, so a fractional size is a size it can actually
                      draw rather than one it rounds away */}
                  <Slider
                    value={size}
                    min={8}
                    max={200}
                    step={0.5}
                    onChange={(ev) => setSize(ev.value)}
                    style={{ flexGrow: 1, minWidth: 120 }}
                  />
                </box>

                {tags.length === 0 && (
                  <text style={s.dim}>
                    This face has no variation axes — `font.variationAxes` is
                    empty, so there is nothing to move.
                  </text>
                )}

                {tags.map((tag) => (
                  <AxisRow
                    key={tag}
                    tag={tag}
                    axis={font.axes[tag]}
                    value={values[tag]}
                    onChange={(v) => setAxis(tag, v)}
                  />
                ))}

                {font.named && (
                  <box style={s.row}>
                    <box style={s.axisName}>
                      <text style={s.axisTag}>named instances</text>
                      <text style={s.axisLabel}>
                        the designer&apos;s own points
                      </text>
                    </box>
                    <Select
                      style={{ width: 240 }}
                      value={picked}
                      placeholder={`${namedNames.length} to choose from…`}
                      options={namedNames}
                      onChange={(ev) => applyNamed(ev.value)}
                    />
                  </box>
                )}
              </box>

              <box style={s.card}>
                <text style={s.dim}>the same text, in react-x11</text>
                <box style={s.code}>
                  <text style={s.codeText}>
                    {snippetFor({ font, size, values, sample })}
                  </text>
                </box>
              </box>
            </>
          )}
        </box>
      </box>
    </window>
  );
}

export default Lab;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<Lab initialFont={process.argv[2] ?? null} />);
}

// A font explorer — what fontconfig would give you, and what it looks like.
//
//   npm run examples:fonts
//   npm run examples:fonts -- ':lang=ja'      # start on a query
//
// Text is the largest thing this renderer does that a web developer never
// has to think about, and the place its bugs have hidden: a cap band rounded
// the wrong way (#327), a baseline taken from the ascent (#328), a field
// whose text does not mirror (#341). All of those passed a green test suite
// and were obvious the moment somebody looked at a specimen. This is the
// specimen.
//
// It is also the answer to the question that starts most font bugs: *which
// font am I actually getting?* On this machine `sans-serif` is Hiragino Sans
// W4 — a Japanese face, with a 0.5em line gap — because that is what
// `fc-match` ranks first, and nothing in an app's code says so (#86). The
// left column is that ranking, and the top row is what you get.
//
// ## What to try
//
//   sans-serif        the default nobody chose. Look at the line gap.
//   :lang=ru          fontconfig patterns pass straight through, so the
//   :lang=ja          query box is the real thing, not a family list.
//   monospace:bold
//
//   Coverage          type ₸ or 字 into the specimen and watch the coverage
//                     line: a character the face does not have is drawn from
//                     somebody else's, and this says whose.
//   Axes              a variable font grows a control per axis it declares —
//                     read off the file, not configured here.
//   Guides            the ascender, cap height, x-height, baseline and
//                     descender, drawn where `metrics()` says they are. These
//                     are the same numbers `_lineMetrics` lays out with, so a
//                     face whose cap band looks wrong here looks wrong in a
//                     `<Button>` too. A line is missing when the face never
//                     declared it.
//   Point at a glyph  its id, the code points it came from, its advance, its
//                     ink box and side bearing — and **which face drew it**,
//                     which is per glyph rather than per string. All of it
//                     off `app.fonts.shape()`, the same shaped run the
//                     renderer draws from.
//   Background / Ink  two gradients: one behind the specimen and one *in* the
//                     glyphs. The second is the interesting one — a vertical
//                     ramp over the text's own ascender-to-descender band.
//   Wrap              the specimen becomes a paragraph, laid out through the
//                     same `app.fonts.layout()` the renderer uses, and every
//                     line gets its **box** drawn. The gap between the box
//                     and the glyphs is the leading, split half above and
//                     half below — the thing that makes a single line sit
//                     off-centre in a control.
//   Line height       a multiplier over the face's **natural** line height,
//                     not over the font size: `×2` on a face whose natural
//                     line is 1.27em gives 2.53em, not 2em. That is CSS's
//                     `line-height` with a different base, deliberately —
//                     `docs/styling.md` says so — and the strip under the
//                     specimen reports what it came to in px.
//   Shadow            a server-side blur (see below).
//
// ## The two decorations, and why they are canvas
//
// A `<box>` has both of these now — `backgroundImage: 'linear-gradient(…)'`
// and `boxShadow` are paint properties (#345). Neither reaches a *glyph*,
// which is what these two are: a ramp that runs down the letterforms over
// the text's own ascender-to-descender band, and a blur of the text's own
// coverage rather than of a rectangle. So both still live in one `<canvas>`,
// which is the honest shape for them anyway: a specimen is a drawing.
//
// The gradient is `ctx.createLinearGradient`, ordinary canvas.
//
// The shadow is the interesting one. There is no `ctx.shadowBlur` here, so
// it is built from the pieces underneath: the text is drawn once into an
// **a8 surface** (a `Surface` stores coverage rather than colour), that
// surface's `Picture` gets a **RENDER convolution filter** — a gaussian, on
// the server — and the blurred coverage is then composited as a *mask* for
// whatever `fillStyle` is set. So the shadow is tinted at composite time,
// nothing but the composite crosses the wire, and the blur happens where the
// pixels already are. `paintShadowedText` below is the whole of it.
//
// ## What does not work
//
// **The list shows PostScript names, not families.** `matchSorted` answers
// `{path, postscriptName, charset}` — fc-match is asked for exactly those —
// so a family name means opening the file, at about 1.2ms each. For 139
// candidates that is 170ms of blocking on every keystroke, which is a worse
// trade than reading `HiraginoSans-W4` instead of `Hiragino Sans W4`. Only
// the selected face is opened.
//
// **Matching blocks.** `matchSorted` shells out to `fc-match` synchronously
// — 109ms cold on this machine, free once memoized. `useDeferredValue` keeps
// the query field responsive while the list catches up, the same shape
// `examples/monitor.jsx` uses for its filter. ntk#274 is the async version.
//
// **Two ntk drawing calls ignore the context transform.** `<canvas>`
// translates the context to the node's origin before `onDraw`, and neither
// `CanvasGradient` (ntk#271) nor `TextLayout.draw` (ntk#280) goes through
// that transform — while `fillText`, `fillRect` and `drawImage` all do. So
// the gradients and the `layout.draw` call here add `node.abs` and nothing
// else does, which is the one thing in this file that cannot be guessed
// from reading it. The text case is the nastier: the *clip* is applied, so
// the paragraph is drawn at the window's edge and then cut, which reads as
// truncation rather than as displacement.
//
// **The glyph inspector walks logical order.** Advances are accumulated in
// the order the runs come back, which is visual order for everything shaped
// here; a right-to-left specimen would need the runs reordered the way the
// painter reorders them, and the box would land on the wrong glyph without
// it (#341 is the neighbouring gap).
//
// **A registered family cannot be replaced.** `FontManager.load` appends and
// `match` keeps the first entry that scores best, so a second file under a
// name already taken never draws, and there is no unregister. `loadFont`
// (#346) is what this app registers through, and it takes the naming half of
// that off the caller — but the name it derives is the file's *family*, and
// a specimen has to distinguish two faces *within* one, so each face is
// registered under its PostScript name. See the effect that does it.
import React, {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  Select,
  Slider,
  Switch,
  createRoot,
  createStyles,
  loadFont,
  openFont,
  useApp,
} from '../src/index.js';
// Through `react-x11/ntk`, never a second `ntk` dependency: two copies mean
// two font caches and two glyph atlases (see `src/ntk.js`). The fonts
// themselves are not opened through here — `openFont` is the app's route to
// one, and it opens through the connection's cache rather than beside it.
import { Surface } from '../src/ntk.js';

const SAMPLE = 'Sphinx of black quartz, judge my vow';

// ---------------------------------------------------------------------------
// The decorations
// ---------------------------------------------------------------------------

const GRADIENTS = [
  { id: 'slate', label: 'Slate', stops: ['#1f2937', '#0f172a'] },
  { id: 'dusk', label: 'Dusk', stops: ['#2b5876', '#4e4376'] },
  { id: 'ember', label: 'Ember', stops: ['#42275a', '#734b6d'] },
  { id: 'moss', label: 'Moss', stops: ['#134e5e', '#71b280'] },
  { id: 'paper', label: 'Paper', stops: ['#f8f7f4', '#e6e2da'] },
  { id: 'none', label: 'None', stops: null },
];

/** Gradients for the glyphs themselves, which is the harder of the two. */
const INKS = [
  { id: 'plain', label: 'Plain', stops: null },
  { id: 'gold', label: 'Gold', stops: ['#ffe29a', '#b8860b'] },
  { id: 'chrome', label: 'Chrome', stops: ['#ffffff', '#7d8794'] },
  { id: 'sunrise', label: 'Sunrise', stops: ['#ffd86f', '#fc6262'] },
  { id: 'neon', label: 'Neon', stops: ['#5ee7df', '#b490ca'] },
];

/** Light gradients want dark ink. Nothing else in the app cares. */
const inkFor = (gradient) => (gradient.id === 'paper' ? '#1c1b19' : '#f4f7ff');

const SPECIMEN_H = 150;
const WRAPPED_H = 300;
const TEXT_X = 18;

/**
 * A blurred copy of a laid-out paragraph, behind it.
 *
 * The blur is the server's: an `a8` surface holds the glyph coverage, a
 * RENDER convolution filter blurs that coverage in place, and compositing it
 * tints it with the current `fillStyle`. The alternative — blurring pixels
 * on the client and uploading them — is the thing this stack exists to avoid.
 *
 * Taking a *layout* rather than a string is what makes this work for wrapped
 * text, and it removes the baseline arithmetic entirely: the surface holds
 * the same box the layout draws into, so the two share an origin.
 */
function paintShadowedLayout(ctx, app, layout, x, y, { blur, offset, colour }) {
  if (!(layout.width > 0)) return;
  // Room for the blur to spread into, or the kernel clips at the surface's
  // edge and the shadow ends in a straight line.
  const pad = blur * 2 + 4;
  const surface = new Surface(app, {
    width: Math.ceil(layout.width) + pad * 2,
    height: Math.ceil(layout.height) + pad * 2,
    format: 'a8',
  });
  try {
    surface.render((c) => {
      c.fillStyle = '#fff'; // full coverage; the colour arrives at composite
      layout.draw(c, pad, pad);
    });
    if (blur > 0) surface.picture().setBlurFilter(blur);
    ctx.fillStyle = colour;
    ctx.drawImage(surface, x - pad + offset, y - pad + offset);
  } finally {
    surface.destroy();
  }
}

const GUIDES = [
  ['ascender', (m) => -m.ascent, '#7fb2ff'],
  ['cap height', (m) => -m.capHeight, '#7ee0a1'],
  ['x-height', (m) => -m.xHeight, '#e0d47e'],
  ['baseline', () => 0, '#ff9d7a'],
  ['descender', (m) => m.descent, '#c79dff'],
];

const guideRows = (baseline, metrics) =>
  GUIDES.map(([label, offsetOf, colour], i) => {
    const offset = offsetOf(metrics);
    return offset == null || Number.isNaN(offset)
      ? null // the face never declared it
      : { label, colour, i, y: Math.round(baseline + offset) };
  }).filter(Boolean);

/** Width kept clear on the right so the labels never sit on the glyphs. */
const GUTTER = 84;

/** The lines. Drawn under the glyphs, which is where a specimen wants them. */
function paintGuideLines(ctx, width, rows, lines) {
  for (const line of lines) {
    ctx.fillStyle = '#ffffff1c';
    ctx.fillRect(0, Math.round(line.top), Math.max(0, width - GUTTER), 1);
    ctx.fillRect(
      0,
      Math.round(line.bottom) - 1,
      Math.max(0, width - GUTTER),
      1,
    );
    ctx.fillStyle = '#ff9d7a55';
    ctx.fillRect(0, Math.round(line.baseline), Math.max(0, width - GUTTER), 1);
  }
  for (const { y, colour } of rows) {
    ctx.fillStyle = colour;
    ctx.fillRect(0, y, Math.max(0, width - GUTTER), 1);
  }
}

/**
 * The labels, in the gutter, and pushed apart where they would collide.
 *
 * At any normal size the ascender, cap height and x-height lines are a few
 * pixels apart, so labels placed at their own y overlap into mush — which
 * they did, until a screenshot said so. Each one may move down to clear the
 * one above; the line it belongs to has not moved, and the colour is what
 * ties the two together.
 */
function paintGuideLabels(ctx, width, height, rows) {
  ctx.font = '9px sans-serif';
  const gap = 11;
  let lowest = -Infinity;
  for (const { label, colour, y } of rows) {
    const at = Math.min(height - 2, Math.max(y, lowest + gap));
    lowest = at;
    ctx.fillStyle = colour;
    ctx.fillText(label, width - GUTTER + 6, at - 2);
  }
}

/** A thin box round one glyph's ink, plus the advance it claims. */
function paintGlyphBox(ctx, hover) {
  const { x, baseline, advance, extents } = hover;
  // The advance — what the next glyph is placed by — as a filled band, and
  // the ink box on top of it. They are different rectangles, which is the
  // whole point of showing them: side bearings are the difference.
  ctx.fillStyle = '#00e5ff44';
  ctx.fillRect(x, baseline - 2, advance, 4);
  if (extents.minX == null) return; // a space has no ink
  const x0 = x + extents.minX;
  const y0 = baseline + extents.minY;
  const w = extents.maxX - extents.minX;
  const h = extents.maxY - extents.minY;
  // A cyan overlay rather than a white one: at `#ffffff88` over gradient ink
  // the box was there and unreadable, which is the same as not being there.
  ctx.fillStyle = '#00e5ffcc';
  ctx.fillRect(x0, y0, w, 1);
  ctx.fillRect(x0, y0 + h - 1, w, 1);
  ctx.fillRect(x0, y0, 1, h);
  ctx.fillRect(x0 + w - 1, y0, 1, h);
}

/** The specimen: a background, guides, a shadow, the face, and a hover box. */
function paintSpecimen(ctx, { width, height, node }, opts) {
  const {
    gradient,
    ink,
    text,
    size,
    family,
    variations,
    shadow,
    metrics,
    guides,
    wrap,
    lineHeight,
    hover,
    report,
  } = opts;
  const app = node.app;
  // **Window coordinates, not the node's.** `<canvas>` translates the context
  // to the node's origin before `onDraw`, and a CanvasGradient's points do
  // not go through that transform, so a gradient built in node coordinates
  // starts at the *window's* edge (ntk#271). Every gradient here is therefore
  // built with `node.abs` added, and that is the only reason it is.
  const { x: ox, y: oy } = node.abs;

  if (gradient.stops) {
    // Horizontal: past its last stop a RENDER gradient is transparent, and a
    // diagonal one runs out before the far corners of the rect.
    const fill = ctx.createLinearGradient(ox, oy, ox + width, oy);
    fill.addColorStop(0, gradient.stops[0]);
    fill.addColorStop(1, gradient.stops[1]);
    ctx.fillStyle = fill;
  } else {
    ctx.fillStyle = '#0e1116';
  }
  ctx.fillRect(0, 0, width, height);

  if (!family || !text) {
    report(null);
    return;
  }

  // Laid out through `app.fonts.layout()` — the same call `<text>` makes —
  // rather than `fillText`, so one code path serves a single line and a
  // wrapped paragraph, and the line boxes become available to draw.
  const style = { family, size, variations: variations ?? undefined };
  style.font = app.fonts.match(style.family, style);
  const layout = app.fonts.layout([{ text, ...style }], style, {
    maxWidth: wrap ? Math.max(32, width - TEXT_X - GUTTER) : undefined,
    lineHeight: lineHeight || undefined,
  });

  // Wrapped text starts at the top; one line stays vertically centred, which
  // is what a specimen wants when there is only one of it.
  const top = wrap ? 14 : Math.round(height / 2 - layout.height / 2);
  // `line.baseline` and `line.y` are both absolute inside the layout box.
  const lines = layout.lines.map((ln) => ({
    top: top + ln.y,
    bottom: top + ln.y + ln.height,
    baseline: top + ln.baseline,
    ascent: ln.ascent,
    descent: ln.descent,
    x: TEXT_X + ln.x,
    runs: ln.runs,
  }));
  report(layout, lines);

  const rows =
    guides && metrics && lines.length
      ? guideRows(lines[0].baseline, metrics)
      : [];
  if (guides) paintGuideLines(ctx, width, rows, lines);

  if (shadow > 0) {
    paintShadowedLayout(ctx, app, layout, TEXT_X, top, {
      blur: shadow,
      offset: Math.round(shadow / 2),
      colour: '#05070a',
    });
  }

  if (ink.stops) {
    // Down the glyphs rather than across them: a vertical ramp over the
    // text's own band is what a metallic or sunset fill means, and it needs
    // the *layout's* box, not the canvas's.
    const fill = ctx.createLinearGradient(
      ox,
      oy + top,
      ox,
      oy + top + layout.height,
    );
    fill.addColorStop(0, ink.stops[0]);
    fill.addColorStop(1, ink.stops[1]);
    ctx.fillStyle = fill;
  } else {
    ctx.fillStyle = inkFor(gradient);
  }
  // **Absolute coordinates, unlike everything else here.** `layout.draw`
  // composites its glyphs straight onto the picture at the positions it is
  // given: it applies the context's *clip* but not its *transform*, so a
  // node-local origin puts the text at the window's left edge — where the
  // clip then cuts it, which looks like a layout bug rather than a transform
  // one. `fillText`, `fillRect` and `drawImage` all honour the transform, so
  // only this call is offset (ntk#280; ntk#271 is the same fault in
  // CanvasGradient).
  layout.draw(ctx, ox + TEXT_X, oy + top);

  if (rows.length) paintGuideLabels(ctx, width, height, rows);
  if (hover) paintGlyphBox(ctx, hover);
}

// ---------------------------------------------------------------------------
// Seam: the catalogue
//
// fontconfig answers differently on every machine — that is the whole point
// of the app and the reason its tests cannot use it. `fixedCatalogue` is a
// list of files, which is what the tests hand it.
//
// `open` takes the connection as its second argument rather than closing
// over one, so a catalogue can be built before there is an app — which is
// what the tests do. Both real ones open through `openFont`, so a file
// fontconfig already matched is not parsed a second time.
// ---------------------------------------------------------------------------

export function fontconfigCatalogue(app) {
  return {
    kind: 'fontconfig',
    /** A raw fontconfig pattern: `sans-serif`, `:lang=ru`, `Menlo:bold`. */
    match(query) {
      // `patternFor` concatenates, so a whole pattern passed as the family
      // reaches fc-match intact — which is why the query box can be the real
      // thing rather than a family picker.
      return app.fonts.source.matchSorted({ family: query || 'sans-serif' });
    },
    open: (path, into) => openFont(into, path),
  };
}

export function fixedCatalogue(paths) {
  return {
    kind: 'fixed',
    match(query) {
      const q = String(query ?? '').toLowerCase();
      const all = paths.map((path) => ({
        path,
        postscriptName: path
          .split('/')
          .pop()
          .replace(/\.[^.]+$/, ''),
        charset: '',
      }));
      if (!q || q === 'sans-serif') return all;
      return all.filter((m) => m.postscriptName.toLowerCase().includes(q));
    },
    open: (path, into) => openFont(into, path),
  };
}

// ---------------------------------------------------------------------------
// Reading a face
// ---------------------------------------------------------------------------

const AXIS_NAMES = {
  wght: 'Weight',
  wdth: 'Width',
  slnt: 'Slant',
  ital: 'Italic',
  opsz: 'Optical size',
};

/** Everything the detail pane shows, or `{ error }` if the file will not open. */
function describe(catalogue, path, size, app) {
  try {
    const font = catalogue.open(path, app);
    return {
      font,
      familyName: font.familyName,
      postscriptName: font.postscriptName,
      unitsPerEm: font.unitsPerEm,
      metrics: font.metrics(size),
      axes: font.variationAxes ?? {},
    };
  } catch (err) {
    return { error: String(err?.message ?? err) };
  }
}

/** Which characters of `text` this face has, and which it does not. */
function coverageOf(font, text) {
  if (!font) return { missing: [], total: 0 };
  const seen = new Set();
  const missing = [];
  for (const ch of text) {
    if (seen.has(ch) || ch === ' ') continue;
    seen.add(ch);
    try {
      if (!font.hasGlyph(ch.codePointAt(0))) missing.push(ch);
    } catch {
      // a face that cannot answer is not a face that is missing the glyph
    }
  }
  return { missing, total: seen.size };
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const s = createStyles({
  root: { flexGrow: 1, flexDirection: 'row', backgroundColor: '$background' },
  side: {
    width: 264,
    flexDirection: 'column',
    gap: 8,
    padding: 12,
    borderEndWidth: 1,
    borderColor: '$border',
  },
  field: {
    height: 30,
    borderWidth: 1,
    borderColor: '$border',
    borderRadius: 6,
    paddingStart: 8,
    paddingEnd: 8,
    backgroundColor: '$surface',
    ':focus': { borderColor: '$accent' },
  },
  quick: { flexDirection: 'row', gap: 4, flexWrap: 'wrap' },
  chip: {
    paddingStart: 7,
    paddingEnd: 7,
    paddingTop: 3,
    paddingBottom: 3,
    borderRadius: 5,
    backgroundColor: '$surface',
    ':hover': { backgroundColor: '$surfaceHover' },
  },
  chipText: { fontSize: 11, color: '$textMuted' },
  list: { flexGrow: 1, overflow: 'scroll', gap: 1 },
  row: {
    flexDirection: 'column',
    gap: 1,
    paddingStart: 8,
    paddingEnd: 8,
    paddingTop: 5,
    paddingBottom: 5,
    borderRadius: 6,
    ':hover': { backgroundColor: '$surfaceHover' },
  },
  rowOn: {
    backgroundColor: '$accent',
    ':hover': { backgroundColor: '$accentHover' },
  },
  rowName: { fontSize: 12, color: '$text' },
  rowNameOn: { color: '$accentText' },
  rowFile: { fontSize: 10, color: '$textMuted' },
  rowFileOn: { color: '$accentText' },
  winner: { fontSize: 10, color: '$success' },

  main: { flexGrow: 1, flexDirection: 'column' },
  specimen: { height: SPECIMEN_H },
  specimenTall: { height: WRAPPED_H },
  glyphBar: {
    paddingStart: 14,
    paddingEnd: 14,
    paddingTop: 5,
    paddingBottom: 5,
    backgroundColor: '$surface',
  },
  glyphText: { fontSize: 11, color: '$text' },
  glyphHint: { fontSize: 11, color: '$textMuted' },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 10,
    paddingStart: 14,
    paddingEnd: 14,
    paddingTop: 8,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderColor: '$border',
  },
  detail: {
    flexGrow: 1,
    overflow: 'scroll',
    flexDirection: 'column',
    gap: 14,
    padding: 14,
  },
  h: { fontSize: 12, color: '$textMuted' },
  family: { fontSize: 20, color: '$text' },
  facts: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  fact: { width: 132, flexDirection: 'column', gap: 1 },
  factLabel: { fontSize: 10, color: '$textMuted' },
  factValue: { fontSize: 13, color: '$text' },
  path: { fontSize: 10, color: '$textMuted' },
  miss: { fontSize: 12, color: '$warning' },
  ok: { fontSize: 12, color: '$success' },
  axis: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  axisName: { width: 120, fontSize: 12, color: '$text' },
  axisValue: { width: 56, fontSize: 12, color: '$textMuted', textAlign: 'end' },
  error: { fontSize: 12, color: '$danger' },
  label: { fontSize: 11, color: '$textMuted' },
});

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

const QUICK = ['sans-serif', 'serif', 'monospace', ':lang=ru', ':lang=ja'];

function MatchList({ matches, selected, onSelect }) {
  return (
    <box style={s.list} data-testname="matches">
      {matches.map((m, i) => {
        const on = m.path === selected;
        return (
          <box
            key={`${m.path}#${m.postscriptName}#${i}`}
            style={[s.row, on && s.rowOn]}
            role="option"
            aria-label={m.postscriptName}
            focusable
            onClick={() => onSelect(m.path)}
          >
            <text style={[s.rowName, on && s.rowNameOn]}>
              {m.postscriptName || '(unnamed)'}
            </text>
            {i === 0 ? (
              <text style={on ? s.rowFileOn : s.winner}>
                what this query gives you
              </text>
            ) : (
              <text style={[s.rowFile, on && s.rowFileOn]}>
                {m.path.split('/').pop()}
              </text>
            )}
          </box>
        );
      })}
    </box>
  );
}

function Facts({ info, size }) {
  const m = info.metrics;
  // `capHeight` and `xHeight` are `null` when the face does not declare them
  // — Comic Sans MS is one — and saying so is more use than a number. The
  // renderer takes the same view: `_lineMetrics` leaves the box alone rather
  // than centring on a value it does not have.
  const px = (v) =>
    v == null || Number.isNaN(v) ? 'not declared' : `${v.toFixed(2)}px`;
  const rows = [
    ['PostScript', info.postscriptName],
    ['Units per em', String(info.unitsPerEm)],
    ['Ascent', px(m.ascent)],
    ['Descent', px(m.descent)],
    ['Line gap', px(m.lineGap)],
    ['Line height', px(m.lineHeight)],
    ['Cap height', px(m.capHeight)],
    ['x-height', px(m.xHeight)],
  ];
  return (
    <box style={{ flexDirection: 'column', gap: 6 }} data-testname="facts">
      <text style={s.h}>{`Metrics at ${size}px`}</text>
      <box style={s.facts}>
        {rows.map(([label, value]) => (
          <box key={label} style={s.fact}>
            <text style={s.factLabel}>{label}</text>
            <text style={s.factValue}>{value}</text>
          </box>
        ))}
      </box>
      {m.lineGap > size * 0.3 ? (
        <text style={s.miss}>
          {`A ${(m.lineGap / size).toFixed(2)}em line gap — this face will set much looser than a Latin one.`}
        </text>
      ) : null}
    </box>
  );
}

function Coverage({ font, text }) {
  const { missing, total } = useMemo(
    () => coverageOf(font, text),
    [font, text],
  );
  return (
    <box style={{ flexDirection: 'column', gap: 4 }} data-testname="coverage">
      <text style={s.h}>Coverage</text>
      {missing.length === 0 ? (
        <text style={s.ok}>
          {`This face has all ${total} characters in the specimen.`}
        </text>
      ) : (
        <text style={s.miss}>
          {`Not in this face: ${missing.join(' ')} — drawn from a fallback, so what you see is another font's work.`}
        </text>
      )}
    </box>
  );
}

function Axes({ axes, values, onChange }) {
  const ids = Object.keys(axes);
  if (!ids.length) {
    return (
      <box style={{ flexDirection: 'column', gap: 4 }} data-testname="axes">
        <text style={s.h}>Variable axes</text>
        <text style={s.label}>
          This face declares none — `font.variationAxes` is empty.
        </text>
      </box>
    );
  }
  return (
    <box style={{ flexDirection: 'column', gap: 8 }} data-testname="axes">
      <text style={s.h}>Variable axes</text>
      {ids.map((id) => {
        const axis = axes[id];
        const value = values[id] ?? axis.default;
        return (
          <box key={id} style={s.axis} role="group" aria-label={id}>
            <text
              style={s.axisName}
            >{`${AXIS_NAMES[id] ?? axis.name ?? id} (${id})`}</text>
            {axis.min === axis.max ? (
              <text style={s.label}>{`pinned at ${axis.min}`}</text>
            ) : (
              <>
                <Slider
                  style={{ flexGrow: 1 }}
                  min={axis.min}
                  max={axis.max}
                  value={value}
                  aria-label={`${id} axis`}
                  onChange={(ev) => onChange(id, ev.value)}
                />
                <text style={s.axisValue}>{Math.round(value)}</text>
              </>
            )}
          </box>
        );
      })}
    </box>
  );
}

export function FontsPanel({
  catalogue: given = null,
  initialQuery = 'sans-serif',
  initialText = SAMPLE,
  initialInk = 'plain',
  initialSize = 30,
  initialLineHeight = 0,
}) {
  const app = useApp();
  const catalogue = useMemo(
    () => given ?? (app ? fontconfigCatalogue(app) : null),
    [given, app],
  );

  const [query, setQuery] = useState(initialQuery);
  const [selected, setSelected] = useState(null);
  const [text, setText] = useState(initialText);
  const [size, setSize] = useState(initialSize);
  const [gradientId, setGradientId] = useState('dusk');
  const [inkId, setInkId] = useState(initialInk);
  const [shadow, setShadow] = useState(7);
  const [guides, setGuides] = useState(true);
  const [wrap, setWrap] = useState(false);
  const [lineHeight, setLineHeight] = useState(initialLineHeight); // 0 = the face's own
  const [hover, setHover] = useState(null);
  const [summary, setSummary] = useState(null);
  const [axisValues, setAxisValues] = useState({});

  // `matchSorted` is a synchronous subprocess — 109ms the first time a
  // pattern is seen. Deferring it keeps the field's caret moving while the
  // list is a keystroke behind, which is the honest trade: the field is the
  // thing being typed into, the list is the thing being read.
  const settled = useDeferredValue(query);

  // A failure is part of the result, not a state update: `matchSorted` throws
  // where fontconfig is missing or has no usable font, and setting state from
  // inside a memo would be a write during render.
  const { matches, failed } = useMemo(() => {
    if (!catalogue) return { matches: [], failed: null };
    try {
      return { matches: catalogue.match(settled).slice(0, 200), failed: null };
    } catch (err) {
      return { matches: [], failed: String(err?.message ?? err) };
    }
  }, [catalogue, settled]);

  // The selection follows the query unless the reader has picked something
  // that is still in the new list.
  const current = matches.some((m) => m.path === selected)
    ? selected
    : (matches[0]?.path ?? null);

  const info = useMemo(
    () =>
      catalogue && current ? describe(catalogue, current, size, app) : null,
    [catalogue, current, size, app],
  );

  useEffect(() => setAxisValues({}), [current]);

  // The specimen draws through `ctx.font`, which resolves through
  // `app.fonts` — so the chosen file has to be registered before it can be
  // named. `loadFont` (#346) registers it and hands the name back, opening
  // through the same cache `describe` above already read the file with, and
  // it is idempotent per file: picking a face a second time costs nothing.
  //
  // **Under its PostScript name, not the family name `loadFont` would
  // derive.** That default is right for an app that ships a font and wrong
  // for this one: `KaTeX_Main-Regular` and `KaTeX_Main-Bold` are one family,
  // `ctx.font` names a family without a weight, and the specimen would go on
  // drawing the regular face while the list says bold. A PostScript name is
  // one face by definition, which is what a specimen has to show.
  const [registered, setRegistered] = useState(null);
  const face = info?.postscriptName ?? null;
  useEffect(() => {
    if (!app || !current || !face) {
      setRegistered(null);
      return;
    }
    try {
      setRegistered(loadFont(app, current, { family: face }).family);
    } catch {
      setRegistered(null);
    }
  }, [app, current, face]);

  const gradient = GRADIENTS.find((g) => g.id === gradientId) ?? GRADIENTS[0];
  const ink = INKS.find((g) => g.id === inkId) ?? INKS[0];
  const variations = useMemo(
    () => (Object.keys(axisValues).length ? axisValues : null),
    [axisValues],
  );

  // The painter hands back the layout it built, because it is the only place
  // that knows the canvas's real width — and a second layout computed here
  // could disagree with the one on screen. This runs from a paint pass
  // rather than a render, so the state update is legal; it is guarded to the
  // values that actually show, or every frame would re-render.
  const linesRef = useRef([]);
  const report = useCallback((layout, lines = []) => {
    linesRef.current = lines;
    const first = lines[0];
    const next = layout
      ? {
          lines: layout.lines.length,
          box: first ? first.bottom - first.top : 0,
          leading: first
            ? first.bottom - first.top - (first.ascent + first.descent)
            : 0,
        }
      : null;
    setSummary((prev) =>
      prev?.lines === next?.lines &&
      prev?.box === next?.box &&
      prev?.leading === next?.leading
        ? prev
        : next,
    );
  }, []);

  /**
   * Which glyph is under a point. The lines come from the layout, so this
   * works the same for one line and for a wrapped paragraph, and the facts
   * come off `run.font` — which is per glyph, so a fallback shows up where a
   * per-string answer would hide it.
   */
  const glyphAt = useCallback((localX, localY) => {
    for (const line of linesRef.current) {
      if (localY < line.top || localY >= line.bottom) continue;
      // A line's `runs` are **slices**, not shaped runs: each carries its own
      // `x` within the line and its own `run`, whose `glyphs` are exactly
      // that slice's. So the cursor restarts per slice rather than running
      // across the line — which is also what makes a wrapped line whose
      // words come from different faces come out right.
      for (const slice of line.runs ?? []) {
        const run = slice.run;
        if (!run?.glyphs) continue;
        let cursor = line.x + slice.x;
        for (const g of run.glyphs) {
          const x = cursor + g.dx;
          if (localX >= x && localX < x + g.ax) {
            return {
              x,
              baseline: line.baseline,
              id: g.id,
              advance: g.ax,
              codePoints: g.codePoints ?? [],
              family: run.font.familyName,
              extents: run.font.glyphExtents(g.id, run.size),
            };
          }
          cursor += g.ax;
        }
      }
    }
    return null;
  }, []);

  const draw = useCallback(
    (ctx, box) =>
      paintSpecimen(ctx, box, {
        gradient,
        ink,
        text,
        size,
        family: registered,
        variations,
        shadow,
        metrics: info?.metrics ?? null,
        guides,
        wrap,
        lineHeight,
        hover,
        report,
      }),
    [
      gradient,
      ink,
      text,
      size,
      registered,
      variations,
      shadow,
      info,
      guides,
      wrap,
      lineHeight,
      hover,
      report,
    ],
  );

  const setAxis = useCallback(
    (id, value) => setAxisValues((prev) => ({ ...prev, [id]: value })),
    [],
  );

  return (
    <box style={s.root}>
      <box style={s.side}>
        <textinput
          style={s.field}
          value={query}
          placeholder="sans-serif"
          aria-label="Font query"
          onChange={(ev) => setQuery(ev.value)}
        />
        <box style={s.quick}>
          {QUICK.map((q) => (
            <box
              key={q}
              style={s.chip}
              role="button"
              aria-label={q}
              focusable
              onClick={() => setQuery(q)}
            >
              <text style={s.chipText}>{q}</text>
            </box>
          ))}
        </box>
        <text style={s.label}>
          {failed ? '' : `${matches.length} candidates, best first`}
        </text>
        {failed ? <text style={s.error}>{failed}</text> : null}
        <MatchList
          matches={matches}
          selected={current}
          onSelect={setSelected}
        />
      </box>

      <box style={s.main}>
        <box style={[s.specimen, wrap && s.specimenTall]}>
          <canvas
            style={{ flexGrow: 1 }}
            onDraw={draw}
            data-testname="specimen"
            onMouseMove={(ev) => {
              // Pointer events carry **window** coordinates, so the node's
              // own origin comes off before the hit test.
              const node = ev.currentTarget ?? ev.target;
              const found = glyphAt(
                ev.x - (node?.abs?.x ?? 0),
                ev.y - (node?.abs?.y ?? 0),
              );
              setHover((prev) =>
                prev?.x === found?.x && prev?.id === found?.id ? prev : found,
              );
            }}
            onMouseLeave={() => setHover(null)}
          />
        </box>

        <box style={s.glyphBar} data-testname="glyph">
          {hover ? (
            <text style={s.glyphText}>
              {`${[...(hover.codePoints ?? [])]
                .map(
                  (c) => `U+${c.toString(16).toUpperCase().padStart(4, '0')}`,
                )
                .join(
                  ' ',
                )}  ·  glyph ${hover.id}  ·  advance ${hover.advance.toFixed(2)}px  ·  ${
                hover.extents.minX == null
                  ? 'no ink'
                  : `ink ${(hover.extents.maxX - hover.extents.minX).toFixed(2)}×${(
                      hover.extents.maxY - hover.extents.minY
                    ).toFixed(2)}px, bearing ${hover.extents.minX.toFixed(2)}px`
              }  ·  drawn from ${hover.family}`}
            </text>
          ) : summary ? (
            <text style={s.glyphHint}>
              {`${summary.lines} line${summary.lines === 1 ? '' : 's'}  ·  line box ${summary.box.toFixed(2)}px (${(summary.box / size).toFixed(2)}em)  ·  leading ${summary.leading.toFixed(2)}px, half of it above the ascender  ·  point at a glyph for its own measurements`}
            </text>
          ) : (
            <text style={s.glyphHint}>
              Point at a glyph for its id, its advance and the face that drew it
              — which is not always the face above.
            </text>
          )}
        </box>

        <box style={s.controls}>
          <textinput
            style={[s.field, { flexGrow: 1 }]}
            value={text}
            placeholder="type a specimen"
            aria-label="Specimen text"
            onChange={(ev) => setText(ev.value)}
          />
          <text style={s.label}>Size</text>
          <Slider
            style={{ width: 110 }}
            min={10}
            max={120}
            value={size}
            aria-label="Size"
            data-testname="size"
            onChange={(ev) => setSize(Math.round(ev.value))}
          />
          <text style={s.label}>{`${size}px`}</text>
          <Select
            style={{ width: 104 }}
            value={gradientId}
            aria-label="Background"
            options={GRADIENTS.map((g) => ({ value: g.id, label: g.label }))}
            onChange={(ev) => setGradientId(ev.value)}
          />
          <Select
            style={{ width: 104 }}
            value={inkId}
            aria-label="Ink"
            options={INKS.map((g) => ({ value: g.id, label: g.label }))}
            onChange={(ev) => setInkId(ev.value)}
          />
          <text style={s.label}>Guides</text>
          <Switch
            checked={guides}
            aria-label="Guides"
            data-testname="guides"
            onChange={(ev) => setGuides(ev.value)}
          />
          <text style={s.label}>Wrap</text>
          <Switch
            checked={wrap}
            aria-label="Wrap"
            data-testname="wrap"
            onChange={(ev) => setWrap(ev.value)}
          />
          <text style={s.label}>Line height</text>
          <Slider
            style={{ width: 96 }}
            min={0}
            max={3}
            step={0.05}
            value={lineHeight}
            aria-label="Line height"
            onChange={(ev) => setLineHeight(ev.value)}
          />
          <text style={s.label}>
            {lineHeight ? `×${lineHeight.toFixed(2)}` : 'from the face'}
          </text>
          <text style={s.label}>Shadow</text>
          <Switch
            checked={shadow > 0}
            aria-label="Shadow"
            data-testname="shadow"
            onChange={(ev) => setShadow(ev.value ? 7 : 0)}
          />
          <Slider
            style={{ width: 90 }}
            min={0}
            max={20}
            value={shadow}
            aria-label="Shadow blur"
            onChange={(ev) => setShadow(Math.round(ev.value))}
          />
        </box>

        <box style={s.detail} data-testname="detail">
          {!info ? (
            <text style={s.label}>Nothing matched that query.</text>
          ) : info.error ? (
            <text style={s.error}>{info.error}</text>
          ) : (
            <>
              <box style={{ flexDirection: 'column', gap: 2 }}>
                <text style={s.family}>{info.familyName}</text>
                <text style={s.path}>{current}</text>
              </box>
              <Facts info={info} size={size} />
              <Coverage font={info.font} text={text} />
              <Axes axes={info.axes} values={axisValues} onChange={setAxis} />
            </>
          )}
        </box>
      </box>
    </box>
  );
}

function App(props) {
  return (
    <window
      width={980}
      height={640}
      title="Fonts"
      wmClass="com.example.x11fonts"
      style={{ flexGrow: 1 }}
    >
      <FontsPanel {...props} />
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<App initialQuery={process.argv[2] || 'sans-serif'} />);
}

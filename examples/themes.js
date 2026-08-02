// Three demo themes, each in light and dark, for exercising the style
// engine: every widget reads these, so switching one swaps the whole UI
// without a single component knowing about it.
//
// They are impressions of the platforms rather than pixel-exact copies —
// enough to show that the theme carries *shape* as well as colour, which is
// most of what separates one platform's controls from another's. `canvas`
// and `panel` are the demo's own tokens, resolved through the `theme` prop
// as `$canvas` / `$panel`; the rest are what the widgets read.

/** GitHub's Primer: square-ish, roomy, green primary buttons. */
const github = {
  light: {
    canvas: '#ffffff',
    panel: '#f6f8fa',
    background: '#f6f8fa',
    text: '#1f2328',
    dim: '#656d76',
    border: '#d0d7de',
    borderFocus: '#0969da',
    accent: '#1f883d',
    accentHover: '#1a7f37',
    accentText: '#ffffff',
    hoverBackground: '#0969da',
    hoverText: '#ffffff',
    surfaceHover: '#eaeef2',
    track: '#d0d7de',
    radius: 6,
    radiusSmall: 4,
    borderWidth: 1,
    fontSize: 14,
    paddingX: 16,
    paddingY: 6,
  },
  dark: {
    canvas: '#0d1117',
    panel: '#161b22',
    background: '#21262d',
    text: '#e6edf3',
    dim: '#8b949e',
    border: '#30363d',
    borderFocus: '#1f6feb',
    accent: '#238636',
    accentHover: '#2ea043',
    accentText: '#ffffff',
    hoverBackground: '#1f6feb',
    hoverText: '#ffffff',
    surfaceHover: '#30363d',
    track: '#30363d',
    radius: 6,
    radiusSmall: 4,
    borderWidth: 1,
    fontSize: 14,
    paddingX: 16,
    paddingY: 6,
  },
};

/** macOS: softer greys, tighter type, the system blue. */
const macos = {
  light: {
    canvas: '#ececec',
    panel: '#ffffff',
    background: '#ffffff',
    text: '#000000',
    dim: '#8e8e93',
    border: '#c6c6c8',
    borderFocus: '#007aff',
    accent: '#007aff',
    accentHover: '#0063cc',
    accentText: '#ffffff',
    hoverBackground: '#007aff',
    hoverText: '#ffffff',
    surfaceHover: '#e8e8ed',
    track: '#d1d1d6',
    radius: 6,
    radiusSmall: 4,
    borderWidth: 1,
    fontSize: 13,
    paddingX: 14,
    paddingY: 5,
  },
  dark: {
    canvas: '#1e1e1e',
    panel: '#2c2c2e',
    background: '#3a3a3c',
    text: '#ffffff',
    dim: '#98989d',
    border: '#48484a',
    borderFocus: '#0a84ff',
    accent: '#0a84ff',
    accentHover: '#3395ff',
    accentText: '#ffffff',
    hoverBackground: '#0a84ff',
    hoverText: '#ffffff',
    surfaceHover: '#48484a',
    track: '#48484a',
    radius: 6,
    radiusSmall: 4,
    borderWidth: 1,
    fontSize: 13,
    paddingX: 14,
    paddingY: 5,
  },
};

/** Windows 11 / Fluent: tighter corners, flatter surfaces. */
const windows = {
  light: {
    canvas: '#f3f3f3',
    panel: '#ffffff',
    background: '#ffffff',
    text: '#1b1b1b',
    dim: '#5d5d5d',
    border: '#d1d1d1',
    borderFocus: '#0067c0',
    accent: '#0067c0',
    accentHover: '#005ba1',
    accentText: '#ffffff',
    hoverBackground: '#0067c0',
    hoverText: '#ffffff',
    surfaceHover: '#ededed',
    track: '#d1d1d1',
    radius: 4,
    radiusSmall: 3,
    borderWidth: 1,
    fontSize: 14,
    paddingX: 14,
    paddingY: 6,
  },
  dark: {
    canvas: '#202020',
    panel: '#2b2b2b',
    background: '#323232',
    text: '#ffffff',
    dim: '#a0a0a0',
    border: '#3d3d3d',
    borderFocus: '#4cc2ff',
    accent: '#4cc2ff',
    // the Windows dark accent is a light blue, so its text goes dark
    accentHover: '#63caff',
    accentText: '#1b1b1b',
    hoverBackground: '#4cc2ff',
    hoverText: '#1b1b1b',
    surfaceHover: '#383838',
    track: '#4a4a4a',
    radius: 4,
    radiusSmall: 3,
    borderWidth: 1,
    fontSize: 14,
    paddingX: 14,
    paddingY: 6,
  },
};

export const THEMES = { github, macos, windows };

export const THEME_OPTIONS = [
  { value: 'github', label: 'GitHub' },
  { value: 'macos', label: 'macOS' },
  { value: 'windows', label: 'Windows' },
];

export const themeFor = (name, mode) =>
  (THEMES[name] ?? THEMES.github)[mode === 'dark' ? 'dark' : 'light'];

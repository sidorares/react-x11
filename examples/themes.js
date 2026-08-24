// Three demo themes, each in light and dark, for exercising the style
// engine: every widget reads these, so switching one swaps the whole UI
// without a single component knowing about it.
//
// They are impressions of the platforms rather than pixel-exact copies —
// enough to show that the theme carries *shape* as well as colour, which is
// most of what separates one platform's controls from another's.
//
// Every key here is a token the widgets read. This demo used to carry two of
// its own — `canvas` for the window's ground and `panel` for the cards on it
// — because the palette had one `background` and all three platforms want
// two: GitHub's `#f6f8fa` controls on white, macOS's white sheets on grey.
// That is what `background` (the ground) and `surface` (what is raised off
// it) are now, so the demo's own tokens are gone.

/** GitHub's Primer: square-ish, roomy, green primary buttons. */
const github = {
  light: {
    background: '#ffffff',
    surface: '#f6f8fa',
    text: '#1f2328',
    textMuted: '#656d76',
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
    paddingY: 10,
  },
  dark: {
    background: '#0d1117',
    surface: '#21262d',
    text: '#e6edf3',
    textMuted: '#8b949e',
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
    paddingY: 10,
  },
};

// The macOS theme also names the platform's faces. On a Mac, fontconfig
// resolves "System Font" to /System/Library/Fonts/SFNS.ttf — San Francisco,
// the family fc-list shows as ".SF NS" — and the mono list to SF Mono.
// Anywhere those are not installed the lists fall through to the generic,
// so the theme stays runnable off-platform; it just stops being a lookalike.
const sfText = '"System Font", "SF Pro Text", sans-serif';
const sfMono = '".SF NS Mono", "SF Mono", monospace';

/** macOS: softer greys, tighter type, the system blue. */
const macos = {
  light: {
    fontFamily: sfText,
    monoFamily: sfMono,
    background: '#ececec',
    surface: '#ffffff',
    text: '#000000',
    textMuted: '#8e8e93',
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
    paddingY: 9,
  },
  dark: {
    fontFamily: sfText,
    monoFamily: sfMono,
    background: '#1e1e1e',
    surface: '#3a3a3c',
    text: '#ffffff',
    textMuted: '#98989d',
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
    paddingY: 9,
  },
};

/** Windows 11 / Fluent: tighter corners, flatter surfaces. */
const windows = {
  light: {
    background: '#f3f3f3',
    surface: '#ffffff',
    text: '#1b1b1b',
    textMuted: '#5d5d5d',
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
    paddingY: 10,
  },
  dark: {
    background: '#202020',
    surface: '#323232',
    text: '#ffffff',
    textMuted: '#a0a0a0',
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
    paddingY: 10,
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

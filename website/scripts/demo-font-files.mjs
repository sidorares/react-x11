// The font faces the playground ships, shared by the module that installs
// them in the browser (demo-fonts.js) and the build step that copies the
// files next to the bundle (build-demo-bundles.mjs). Kept import-free so the
// build script can read it without pulling ntk in.

export const FONT_FILES = [
  { file: 'DejaVuSans.ttf', family: 'DejaVu Sans' },
  { file: 'DejaVuSans-Bold.ttf', family: 'DejaVu Sans' },
  { file: 'DejaVuSans-Oblique.ttf', family: 'DejaVu Sans' },
  { file: 'DejaVuSerif.ttf', family: 'DejaVu Serif' },
  { file: 'DejaVuSansMono.ttf', family: 'DejaVu Sans Mono' },
];

// What `fontFamily: 'sans-serif'` resolves to without fontconfig.
export const FONT_ALIASES = {
  'sans-serif': 'DejaVu Sans',
  serif: 'DejaVu Serif',
  monospace: 'DejaVu Sans Mono',
};

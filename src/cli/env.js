// Every REACT_X11_* variable the renderer reads, for `react-x11 help`.
//
// The renderer reads them, not this command: each one works the same in
// front of `react-x11 dev`, `node app.js` or a `.desktop` launcher, and the
// list is here because the CLI is the one place a developer can ask for it.
// test/cli-help.test.js holds it to src/: a variable read there and missing
// here fails, and so does one listed here that nothing reads any more.
//
// `value` is how the variable is set, shown after the name; `text` says what
// it does, with the default where there is one.

export const ENVIRONMENT = [
  {
    title: 'Backend and display',
    vars: [
      {
        name: 'REACT_X11_BACKEND',
        value: 'x11|cocoa|wayland|win32|auto',
        text:
          "The backend, over createRoot({ backend }) and the platform's " +
          'default: Cocoa on macOS, win32 on Windows, X11 elsewhere. Wayland ' +
          'is only ever used when it is named.',
      },
      {
        name: 'REACT_X11_SCALE',
        value: '<0.5–8>',
        text:
          'Device pixels per logical pixel. Outranks GDK_SCALE, ' +
          "QT_SCALE_FACTOR, the desktop's settings and even a numeric " +
          'createRoot({ scale }).',
      },
      {
        name: 'REACT_X11_FRAME_RATE',
        value: 'display|adaptive|throughput|<fps>',
        text:
          "Every window's frame rate, over its frameRate prop and " +
          'createRoot({ frameRate }).',
      },
      {
        name: 'REACT_X11_TEXT_STRIP_BELOW',
        value: '<px>',
        text:
          'The size under which <text> paints as a strip of ink rather than ' +
          'glyphs, where createRoot({ textStripBelow }) is unset. Default 6; ' +
          '0 paints glyphs at every size.',
      },
      {
        name: 'REACT_X11_FONT_SOURCE',
        value: '<dir|file>',
        text:
          'X11: the fonts to use on a machine without fontconfig (no ' +
          'fc-match), where createRoot({ fontSource }) is unset — a ' +
          'directory of .ttf/.otf files or one font file.',
      },
      {
        name: 'REACT_X11_THREADED',
        value: '0',
        text:
          'macOS: keep the app on the main thread, pumping AppKit, instead ' +
          'of moving it onto a worker.',
      },
    ],
  },
  {
    title: 'Desktop integration',
    vars: [
      {
        name: 'REACT_X11_A11Y',
        value: '0|1',
        text:
          '0 turns the accessibility bridge off. Any other value turns it on ' +
          'even under NO_AT_BRIDGE, and says why when it cannot start.',
      },
      {
        name: 'REACT_X11_A11Y_INTERVAL',
        value: '<ms>',
        text:
          'How often a stream of changes — a scroll, a value ticking — is ' +
          'pushed to assistive technology. Default 500; 0 pushes every ' +
          'change.',
      },
      {
        name: 'REACT_X11_NO_GLOBAL_MENU',
        value: '1',
        text: "<MenuBar> always draws its own bar, never the desktop panel's.",
      },
      {
        name: 'REACT_X11_NO_TRANSPARENCY',
        value: '1',
        text:
          'Pretend there is no compositor: transparent windows are created ' +
          'opaque.',
      },
      {
        name: 'REACT_X11_NO_APPEARANCE_CACHE',
        value: '1',
        text:
          "Do not keep the desktop's appearance in the cache directory, for a " +
          'process that must not touch the disk.',
      },
    ],
  },
  {
    title: 'Development',
    vars: [
      {
        name: 'REACT_X11_DEVTOOLS',
        value: '1|0',
        text:
          'Connect to React DevTools (npx react-devtools). On under ' +
          'react-x11 dev; 0 turns it off.',
      },
      {
        name: 'REACT_X11_DEVTOOLS_HOST',
        value: '<host>',
        text: 'Where React DevTools listens. Default localhost.',
      },
      {
        name: 'REACT_X11_DEVTOOLS_PORT',
        value: '<port>',
        text: 'The port React DevTools listens on. Default 8097.',
      },
      {
        name: 'REACT_X11_DEVTOOLS_STATE',
        value: '<file>',
        text:
          "Where DevTools' settings are kept between runs. Default " +
          'react-x11/devtools.json in the cache directory.',
      },
      {
        name: 'REACT_X11_CLICK_TO_COMPONENT',
        value: '1|0',
        text:
          "Alt+Click (Option+Click on macOS) opens an element's JSX line in " +
          'your editor. On under react-x11 dev; 0 turns it off.',
      },
      {
        name: 'REACT_X11_EDITOR',
        value: '<command>',
        text:
          'The editor click-to-component and the dev error window open: ' +
          'cursor (the default), code, code-insiders, windsurf, vim, nvim. ' +
          'Setting it also turns click-to-component on.',
      },
      {
        name: 'REACT_X11_STRICT_TOKENS',
        value: '1',
        text:
          'A $token the theme does not define throws, instead of being ' +
          'dropped and reported.',
      },
    ],
  },
  {
    title: 'Diagnostics',
    vars: [
      {
        name: 'REACT_X11_TRACE',
        value: 'summary|requests|chrome:<file>',
        text:
          'Record the X11 protocol: an opcode histogram at exit, a line per ' +
          'request, or Chrome Trace Event JSON. +stacks after requests or ' +
          'chrome names the JS call behind each request.',
      },
      {
        name: 'REACT_X11_DEBUG_PAINT',
        value: '1|full',
        text:
          "Stroke each frame's damage rects in a rotating colour. full also " +
          'warns, with the reasons and a stack, on every full-window repaint.',
      },
      {
        name: 'REACT_X11_DEBUG_LAYOUT',
        value: '1',
        text: 'Outline every laid-out node, coloured by tree depth.',
      },
      {
        name: 'REACT_X11_DEBUG_SCALE',
        value: '1',
        text: 'Print the evidence for the display scale, and the verdict.',
      },
      {
        name: 'REACT_X11_PAINT_CACHE',
        value: 'verify',
        text:
          'Re-render every paint-cache hit and fail loudly where it differs ' +
          'from the entry: the check for a cache key that misses a ' +
          'dependency. Slow.',
      },
      {
        name: 'REACT_X11_DEBUG_PAINT_CACHE',
        value: '1',
        text: "Log the paint cache's size, hits and misses every frame.",
      },
      {
        name: 'REACT_X11_DEBUG_URI',
        value: '1',
        text:
          'Narrate URI-scheme handling, with queries and fragments stripped ' +
          'so it is safe to paste into an issue.',
      },
    ],
  },
  {
    title: 'Optimisations off (each answers only to 1)',
    intro:
      'For measuring one against the plain path on the same build, and as ' +
      'first aid when it misrenders.',
    vars: [
      {
        name: 'REACT_X11_NO_PAINT_CACHE',
        value: '1',
        text: 'Paint every node live; no cached pixels.',
      },
      {
        name: 'REACT_X11_NO_SCROLL_BLIT',
        value: '1',
        text:
          'A scroll, or a subtree that only moved, repaints instead of ' +
          'copying the pixels it already has.',
      },
      {
        name: 'REACT_X11_NO_BOUNDS_CACHE',
        value: '1',
        text: "Recompute each subtree's paint reach on every pass.",
      },
      {
        name: 'REACT_X11_NO_SCOPED_FLOORS',
        value: '1',
        text:
          'Measure content floors over the whole tree on every layout ' +
          'change.',
      },
      {
        name: 'REACT_X11_NO_UNREAD_WIDTHS',
        value: '1',
        text:
          "Measure every box's min-content width, read or not, in the width " +
          'passes.',
      },
      {
        name: 'REACT_X11_NO_REFIT_HOLD',
        value: '1',
        text:
          "An 'auto'-sized window lays out at its old size rather than wait " +
          "for the server's answer to its resize.",
      },
      {
        name: 'REACT_X11_NO_PANE_SHAPE',
        value: '1',
        text:
          "X11: a <glarea> overlay pane stays the rectangle of its child's " +
          'reach instead of being cut to its ink.',
      },
      {
        name: 'REACT_X11_NO_SHADOW_TILES',
        value: '1',
        text: 'macOS, Windows: draw every shadow live, not from cached tiles.',
      },
      {
        name: 'REACT_X11_NO_STROKE_CHUNKING',
        value: '1',
        text:
          'macOS: hand each stroke to CoreGraphics whole, however many ' +
          'subpaths it has.',
      },
    ],
  },
  {
    title: 'macOS (Cocoa)',
    vars: [
      {
        name: 'REACT_X11_COCOA_PRESENTER',
        value: 'surface|layers',
        text:
          'How windows reach the screen: one surface (the default) or ' +
          'retained CALayers.',
      },
      {
        name: 'REACT_X11_COCOA_PROMOTE',
        value: '1|0',
        text:
          'Whether the nodes that animate get layers of their own: 1 always, ' +
          '0 never. Default on where the bridge draws in sRGB.',
      },
      {
        name: 'REACT_X11_COCOA_PANE_STRETCH',
        value: 'behind|never|always',
        text:
          "When a <Frame> pane's last frame is stretched while a resize waits " +
          'for the next. Default behind.',
      },
      {
        name: 'REACT_X11_CALAYERS_PATH',
        value: '<path>',
        text:
          'Load the @windowkit/appkit bridge from a checkout or an extracted ' +
          'tarball instead of the installed package.',
      },
    ],
  },
  {
    title: 'Wayland',
    vars: [
      {
        name: 'REACT_X11_GL_DEVICE',
        value: '<path>',
        text:
          'The DRM render node to draw on (/dev/dri/renderD128), where ' +
          'glPolicy.devicePath is unset.',
      },
      {
        name: 'REACT_X11_WAYLAND_FRAME_STALL_MS',
        value: '<ms>',
        text:
          'How long a frame callback may be outstanding before the window ' +
          'counts as not shown. Default 2000; 0 turns the watch off.',
      },
      {
        name: 'REACT_X11_WAYLAND_TRACE',
        value: '1',
        text:
          'A line on stderr per presented frame, text-input event and ' +
          'eyedropper step.',
      },
      {
        name: 'REACT_X11_WAYLAND_SNAPSHOT',
        value: '<file.png>',
        text:
          "Write the first window's frame, read back from the GPU, to this " +
          'file: a screenshot where the desktop offers no screenshot API.',
      },
      {
        name: 'REACT_X11_WAYLAND_SNAPSHOT_AT',
        value: '<n>',
        text: 'Which presented frame the snapshot is. Default 30.',
      },
    ],
  },
  {
    title: 'Windows (win32)',
    vars: [
      {
        name: 'REACT_X11_WIN32_PATH',
        value: '<path>',
        text:
          'Load the @windowkit/win32 bridge from a checkout instead of the ' +
          'installed package.',
      },
      {
        name: 'REACT_X11_WIN32_DEBUG',
        value: '1',
        text:
          'Report every frame and what it drew into, the size each paragraph ' +
          'is shaped at, and drag and drop.',
      },
      {
        name: 'REACT_X11_WIN32_FULL_REPAINT',
        value: '1',
        text: 'Paint the whole window every frame: the control for a damage bug.',
      },
      {
        name: 'REACT_X11_TRACE_IME',
        value: '1',
        text: 'A line on stderr per input-method event.',
      },
      {
        name: 'REACT_X11_TRACE_A11Y',
        value: '1',
        text: 'A line on stderr per UI Automation push and action.',
      },
      {
        name: 'REACT_X11_GL_DEBUG',
        value: '1',
        text:
          '<glarea>: check every GL call against glGetError, list the GL ' +
          'names asked for that are missing, and print frame timings every ' +
          '30 swaps. The GL_ variables below need it.',
      },
      {
        name: 'REACT_X11_GL_TOP',
        value: '<n>',
        text: 'How many of the most-called GL verbs it lists. Default 12.',
      },
      {
        name: 'REACT_X11_GL_TRACE',
        value: '<n>',
        text: 'Print the first n GL calls, with their arguments.',
      },
      {
        name: 'REACT_X11_GL_TRACE_AFTER',
        value: '<swaps>',
        text: 'Start that trace after this many frames. Default 0.',
      },
      {
        name: 'REACT_X11_GL_PEEK',
        value: '<n>',
        text:
          'Read the stencil and the colour at the middle of the surface ' +
          'after each of the first n draws.',
      },
      {
        name: 'REACT_X11_GL_FORCE_CLEAR',
        value: '1',
        text:
          'Clear the GL surface magenta, to tell it apart from the 2D layer ' +
          'behind it.',
      },
    ],
  },
  {
    title: 'Set by react-x11 itself',
    intro: 'Listed so they are not a mystery in an environment dump.',
    vars: [
      {
        name: 'REACT_X11_FRAME',
        value: '1',
        text: "Set on a <Frame> pane's process by the host that forked it.",
      },
      {
        name: 'REACT_X11_DEVTOOLS_PROFILING',
        text:
          "Carried across DevTools' Reload and start profiling: the " +
          'profiling to start with.',
      },
      {
        name: 'REACT_X11_DEVTOOLS_SESSION',
        text:
          "Carried across the same restart: the session storage a browser's " +
          'reload would have kept.',
      },
    ],
  },
];

/**
 * `text` broken into lines of at most `width` columns, each `indent`ed. A
 * `{ … }` stays whole, so `createRoot({ scale })` is never cut after its
 * brace.
 */
function wrap(text, width, indent) {
  const lines = [];
  let line = '';
  for (const word of text.match(/(?:\{[^}]*\}|\S)+/g) ?? []) {
    if (line && indent.length + line.length + 1 + word.length > width) {
      lines.push(indent + line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(indent + line);
  return lines.join('\n');
}

/** The list as `react-x11 help` prints it, wrapped to `width` columns. */
export function formatEnvironment(width = 80) {
  const out = ['Environment variables:'];
  for (const group of ENVIRONMENT) {
    out.push('', group.title);
    if (group.intro) out.push(wrap(group.intro, width, '  '));
    for (const { name, value, text } of group.vars) {
      out.push(`  ${value ? `${name}=${value}` : name}`);
      out.push(wrap(text, width, '      '));
    }
  }
  return `${out.join('\n')}\n`;
}

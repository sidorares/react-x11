// Source locations and the editor that opens them: reading a stack trace
// into frames, telling the frames of an app's own code from React's and this
// renderer's, and handing a file and line to the developer's editor. Shared by
// click-to-component (an Alt+Click on an element) and `react-x11 dev`'s error
// window (a click on a frame), so the two open the same editor the same way.
// A leaf: nothing here reaches the renderer or React DevTools.
import { spawn } from 'node:child_process';
import { dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STACK_FRAME = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/;

// The frames to walk past before the JSX call site itself: React captures
// the Error inside `jsxDEV`/`createElement`, and an element created by this
// renderer (or by node internals) is never what a click means. `SELF_DIR` is
// whichever copy of react-x11 is running — the repo's own `src/` for the
// examples and tests, an installed `node_modules/react-x11/src` for an app.
//
// Everything *else* in `node_modules` is deliberately not skipped here: a
// frame inside an installed package is a real call site, it is just not one
// in the application's source, and telling the two apart is what lets
// `resolveOwnedLocation` climb to the owner that is. Skipping every
// `node_modules` frame instead would walk straight past the library
// component and land on whatever application frame happens to be deeper in
// the render stack — usually the `render()` call at startup, which looks
// like an answer and isn't.
const REACT_RUNTIME =
  /[\\/]node_modules[\\/](react|react-dom|react-reconciler|react-refresh|scheduler)[\\/]/;
const SELF_DIR = dirname(fileURLToPath(import.meta.url)) + sep;

export function isInternalFrame(file) {
  return (
    file.startsWith('node:') ||
    file === '<anonymous>' ||
    file.startsWith(SELF_DIR) ||
    REACT_RUNTIME.test(file)
  );
}

// GUI editors: navigate their registered URI scheme (same idea as
// https://github.com/sidorares/show-component, minus the browser) instead of
// spawning their CLI shim. The CLI wrapper (e.g. `cursor -g ...`) round-trips
// through a shell script that re-detects and re-execs the real app, which is
// visibly slower than the OS handing the URL straight to the already-running
// instance via Launch Services (macOS) / xdg-open (Linux).
const EDITOR_SCHEMES = {
  cursor: 'cursor',
  code: 'vscode',
  vscode: 'vscode',
  'code-insiders': 'vscode-insiders',
  'vscode-insiders': 'vscode-insiders',
  windsurf: 'windsurf',
};

// Terminal editors have no URI scheme to navigate — spawn them directly.
const EDITOR_CLI = {
  vim: (file, line, column) => [
    'vim',
    [`+call cursor(${line},${column})`, file],
  ],
  nvim: (file, line, column) => [
    'nvim',
    [`+call cursor(${line},${column})`, file],
  ],
};

const OPEN_URI_COMMAND = process.platform === 'darwin' ? 'open' : 'xdg-open';

function editorUri(scheme, file, line, column) {
  return `${scheme}://file${encodeURI(file)}:${line}:${column}`;
}

export function openInEditor({ file, line, column }) {
  const name = editorName();
  let bin, args;
  if (EDITOR_CLI[name]) {
    [bin, args] = EDITOR_CLI[name](file, line, column);
  } else {
    // an unrecognized name is assumed to be a URI scheme itself, so any
    // editor that registers one works without a matching entry above
    const scheme = EDITOR_SCHEMES[name] || name;
    bin = OPEN_URI_COMMAND;
    args = [editorUri(scheme, file, line, column)];
  }
  // stderr is kept (rather than the whole stdio ignored) for one reason:
  // `open`/`xdg-open` exit non-zero and print *there* when nothing claims
  // the scheme — an editor that isn't installed, or one whose URL handler
  // was never registered. Swallowing that is what makes click-to-component
  // look like it only logs: the location resolves, the console line prints,
  // and the editor silently never opens.
  const child = spawn(bin, args, {
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  // ...and unref'd, so keeping it does not keep the process alive: a pipe is
  // a ref'd handle, and an editor that outlives the app it was launched from
  // is the normal case, not a reason to hold the event loop open.
  child.stderr.unref();
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.on('error', (err) => {
    console.warn(
      `react-x11: could not launch "${bin}" to open ${file}:${line} (${err.code ?? err.message}). ` +
        'Set REACT_X11_EDITOR to your editor CLI (cursor, code, code-insiders, windsurf, vim, nvim).',
    );
  });
  child.on('exit', (code) => {
    if (!code) return;
    console.warn(
      `react-x11: opening ${file}:${line} — \`${bin} ${args.join(' ')}\` exited ${code}. ` +
        (stderr.trim() ? `${stderr.trim()} ` : '') +
        `Set REACT_X11_EDITOR to the editor you actually use (currently "${name}"; ` +
        'cursor, code, code-insiders, windsurf, vim, nvim, or any registered URI scheme).',
    );
  });
  child.unref();
}

/** The editor `openInEditor` opens: `REACT_X11_EDITOR`, else `cursor`. */
export function editorName() {
  return process.env.REACT_X11_EDITOR || 'cursor';
}

/**
 * A stack trace's frames, in order: where each one is, what it is called, and
 * whether it is React's, Node's or this renderer's own (`internal`) or inside
 * an installed package (`installed`). Lines that are not frames — the message,
 * a `[cause]` — are not in the list.
 */
export function stackFrames(stack) {
  const frames = [];
  for (const text of String(stack ?? '').split('\n')) {
    const match = text.match(STACK_FRAME);
    if (!match) continue;
    const [, functionName, rawFile, lineStr, columnStr] = match;
    const file = rawFile.startsWith('file://')
      ? fileURLToPath(rawFile)
      : rawFile;
    frames.push({
      functionName: functionName ?? null,
      file,
      line: Number(lineStr),
      column: Number(columnStr),
      internal: isInternalFrame(file),
      installed: file.includes(`${sep}node_modules${sep}`),
    });
  }
  return frames;
}

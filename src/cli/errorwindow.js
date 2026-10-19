// The window `react-x11 dev` shows an error in: what was thrown, the source
// around where, and the frames of the stack, each of which opens its line in
// the editor (src/editor.js, the one click-to-component uses).
//
// Two kinds of error reach it. A **render** error takes the app's tree down —
// React unmounts a root whose render threw and nothing caught — so this
// window stands in for the app until the next save mounts it again. A
// **compile** error is a save that did not compile: the app keeps running the
// module's last version, and this window opens beside it until a save
// compiles.
//
// Everything the window says comes out of `describeError`, which is pure, so
// the tests can read it without rendering anything.
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import React from 'react';
import { editorName, openInEditor, stackFrames } from '../editor.js';

const h = React.createElement;

/** Lines of source shown above and below the one that threw. */
const CONTEXT_ABOVE = 3;
const CONTEXT_BELOW = 2;

function firstLine(text) {
  const at = text.indexOf('\n');
  return at === -1 ? text : text.slice(0, at);
}

/**
 * The source lines around `line` (1-based) of `file`: `{ number, text, at }`
 * each, `at` marking the one that threw. Null when the file cannot be read.
 */
function excerptOf(file, line) {
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const lines = source.split('\n');
  if (line < 1 || line > lines.length) return null;
  const from = Math.max(1, line - CONTEXT_ABOVE);
  const to = Math.min(lines.length, line + CONTEXT_BELOW);
  const excerpt = [];
  for (let number = from; number <= to; number++) {
    excerpt.push({
      number,
      // a tab is as wide as its font says, and two spaces is what an editor
      // with a two-space indent shows
      text: lines[number - 1].replace(/\t/g, '  ').replace(/\r$/, ''),
      at: number === line,
    });
  }
  return excerpt;
}

/**
 * Everything the window says about one failure, as data.
 *
 * `failure` is `{ kind, error, filename?, componentStack? }`: `kind` is
 * `'render'` or `'compile'`, `filename` the module that did not compile, and
 * `componentStack` what React handed `onUncaughtError`.
 */
export function describeError(failure, cwd = process.cwd()) {
  const { kind, error, filename = null, componentStack = '' } = failure;
  const rel = (file) => relative(cwd, file) || file;
  const message = String(error?.message ?? error);
  const name = error?.name && error.name !== 'Error' ? error.name : 'Error';

  let heading;
  let detail = '';
  let location = null;
  if (kind === 'compile') {
    // babel says `<file>: <what> (<line>:<column>)` and then draws a frame;
    // the window draws its own from `loc`, when there is one
    let what = firstLine(message);
    if (filename && what.startsWith(`${filename}: `)) {
      what = what.slice(filename.length + 2);
    }
    what = what.replace(/ \(\d+:\d+\)$/, '');
    heading = `${name}: ${what}`;
    if (filename && error?.loc?.line) {
      location = {
        file: filename,
        line: error.loc.line,
        column: (error.loc.column ?? 0) + 1,
      };
    } else {
      detail = message.slice(firstLine(message).length).replace(/^\n+/, '');
    }
  } else {
    heading = `${name}: ${firstLine(message)}`;
    detail = message.slice(firstLine(message).length).replace(/^\n+/, '');
  }

  // A compile error's stack is the compiler's: where in babel the parse
  // gave up, which says nothing about the app.
  const all = kind === 'compile' ? [] : stackFrames(error?.stack);
  const shown = all.filter((frame) => !frame.internal);
  if (!location) {
    const own = shown.find((frame) => !frame.installed) ?? shown[0];
    if (own) {
      location = { file: own.file, line: own.line, column: own.column };
    }
  }

  // React's component stack, innermost first: `at Broken (…)`. Host
  // elements are in it too; the breadcrumb is the components.
  const components = [];
  for (const text of String(componentStack).split('\n')) {
    const match = text.match(/^\s*at ([A-Z][\w$.]*)/);
    if (match) components.push(match[1]);
  }

  return {
    kind,
    heading,
    detail,
    location: location && {
      ...location,
      where: `${rel(location.file)}:${location.line}:${location.column}`,
    },
    excerpt: location ? excerptOf(location.file, location.line) : null,
    frames: shown.map((frame) => ({
      label: frame.functionName ?? '(anonymous)',
      where: `${rel(frame.file)}:${frame.line}:${frame.column}`,
      file: frame.file,
      line: frame.line,
      column: frame.column,
      own: !frame.installed,
    })),
    hidden: all.length - shown.length,
    components: components.reverse(),
  };
}

const mono = { fontFamily: '$monoFamily', fontSize: 12 };

/**
 * A row that opens a source line: drawn pressed on the press and hovered
 * under the pointer, because a click that opens another application takes a
 * moment to show anything of its own.
 */
function SourceLink({ target, children }) {
  const open = () => openInEditor(target);
  return h(
    'box',
    {
      focusable: true,
      role: 'link',
      onClick: open,
      onKeyDown: (ev) => {
        if (ev.key === 'Enter') open();
      },
      style: {
        flexDirection: 'row',
        gap: 10,
        paddingTop: 3,
        paddingBottom: 3,
        paddingStart: 6,
        paddingEnd: 6,
        borderRadius: '$radiusSmall',
        cursor: 'pointer',
        ':hover': { backgroundColor: '$surfaceHover' },
        ':active': { backgroundColor: '$surfaceActive' },
      },
    },
    children,
  );
}

function Excerpt({ excerpt, column }) {
  const width = String(excerpt[excerpt.length - 1].number).length;
  const rows = [];
  for (const { number, text, at } of excerpt) {
    rows.push(
      h(
        'box',
        { key: number, style: { flexDirection: 'row' } },
        h(
          'text',
          {
            style: {
              ...mono,
              color: at ? '$danger' : '$textMuted',
              textWrap: 'nowrap',
            },
          },
          `${at ? '>' : ' '} ${String(number).padStart(width)} │ `,
        ),
        h(
          'text',
          {
            style: {
              ...mono,
              color: at ? '$text' : '$textMuted',
              textWrap: 'nowrap',
              flexShrink: 1,
            },
          },
          text || ' ',
        ),
      ),
    );
    if (at && column > 0) {
      rows.push(
        h(
          'text',
          {
            key: 'caret',
            style: { ...mono, color: '$danger', textWrap: 'nowrap' },
          },
          `${' '.repeat(width + 5 + column - 1)}^`,
        ),
      );
    }
  }
  return h(
    'box',
    {
      style: {
        backgroundColor: '$surfaceHover',
        borderRadius: '$radius',
        paddingTop: 10,
        paddingBottom: 10,
        paddingStart: 12,
        paddingEnd: 12,
        overflow: 'hidden',
      },
    },
    rows,
  );
}

/**
 * The window itself. `onCloseRequest` is the host's to give: without one,
 * closing the only window there is ends the app, as closing an app's primary
 * window does.
 */
export function ErrorWindow({ failure, title, onCloseRequest }) {
  const info = describeError(failure);
  const muted = { color: '$textMuted', fontSize: 12 };
  const editor = editorName();
  const children = [
    h(
      'text',
      { key: 'kind', style: { ...muted, fontWeight: 600 } },
      info.kind === 'compile'
        ? 'This save did not compile. The app keeps running the last version that did.'
        : 'The app threw while rendering, and React took its tree down.',
    ),
    h(
      'text',
      {
        key: 'heading',
        style: { color: '$danger', fontSize: 16, fontWeight: 600 },
      },
      info.heading,
    ),
  ];
  if (info.components.length > 0) {
    children.push(
      h(
        'text',
        { key: 'components', style: muted },
        info.components.join(' › '),
      ),
    );
  }
  if (info.detail) {
    children.push(
      h(
        'text',
        { key: 'detail', style: { ...mono, color: '$text' } },
        info.detail,
      ),
    );
  }
  if (info.location) {
    children.push(
      h(
        'box',
        { key: 'source', style: { gap: 6 } },
        h(
          SourceLink,
          { target: info.location },
          h(
            'text',
            { style: { ...mono, color: '$link' } },
            info.location.where,
          ),
        ),
        info.excerpt
          ? h(Excerpt, { excerpt: info.excerpt, column: info.location.column })
          : null,
      ),
    );
  }
  if (info.frames.length > 0) {
    children.push(
      h(
        'box',
        { key: 'frames', style: { gap: 1 } },
        h(
          'text',
          { style: { ...muted, fontWeight: 600, marginBottom: 4 } },
          'Stack',
        ),
        info.frames.map((frame, i) =>
          h(
            SourceLink,
            { key: i, target: frame },
            h(
              'text',
              {
                style: {
                  ...mono,
                  color: frame.own ? '$text' : '$textMuted',
                  fontWeight: frame.own ? 600 : 400,
                },
              },
              frame.label,
            ),
            h(
              'text',
              { style: { ...mono, color: '$textMuted', flexShrink: 1 } },
              frame.where,
            ),
          ),
        ),
        info.hidden > 0
          ? h(
              'text',
              { style: { ...muted, marginTop: 4, marginLeft: 6 } },
              `${info.hidden} more ${info.hidden === 1 ? 'frame' : 'frames'} in React, Node and react-x11, not shown.`,
            )
          : null,
      ),
    );
  }
  children.push(
    h(
      'text',
      { key: 'footer', style: { ...muted, marginTop: 4 } },
      (info.kind === 'compile'
        ? 'Fix it and save: this window goes once the file compiles. '
        : 'Fix it and save: the app is mounted again on the next reload. ') +
        `Click a line to open it in ${editor}` +
        (process.env.REACT_X11_EDITOR
          ? '.'
          : '; REACT_X11_EDITOR names another editor.'),
    ),
  );

  return h(
    'window',
    { title, width: 760, minHeight: 240, onCloseRequest },
    h(
      'box',
      {
        selectable: true,
        style: { flexGrow: 1, padding: 20, gap: 14, overflow: 'scroll' },
      },
      children,
    ),
  );
}

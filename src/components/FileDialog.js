// The bottom rung of the file-dialog ladder: a browser react-x11 draws
// itself, for every machine that has a display and nothing else — ssh, a bare
// `startx`, a container, a Mac with neither a portal nor `osascript`.
//
// It is a **real top-level window**, not a `<popup>`: a file dialog is
// something the window manager should place, stack and decorate, and
// `transientFor` is what makes it behave like a dialog rather than a second
// application. That is also the shape the portal would have given, so an app
// that moves between machines does not change how its dialog behaves.
//
// Deliberately not a re-creation of GTK's chooser. What it owes the user is:
// get anywhere on the filesystem, see what is there, filter it, type a path
// when the list is the slow way round, and never trap them — which is the set
// below and nothing else.

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { createStyles } from '../styles.js';
import { Button } from './Button.js';
import { Checkbox } from './Checkbox.js';
import { Select } from './Select.js';
import { Table } from './Table.js';
import { ThemeProvider, useTheme } from './theme.js';

const h = React.createElement;

const ALL_FILES = '__all__';

// Stat-ing every entry is one syscall each, which is nothing on a local
// filesystem and very much something on a network mount with ten thousand
// files in one directory. Past this, sizes and dates are left blank rather
// than making the dialog take a visible pause to open.
const STAT_LIMIT = 5000;

const s = createStyles({
  window: { flexDirection: 'column', padding: 10, gap: 8 },
  bar: { flexDirection: 'row', gap: 6, alignItems: 'center', flexShrink: 0 },
  path: { flexGrow: 1, flexBasis: 0 },
  list: { flexGrow: 1, minHeight: 0 },
  footer: { flexDirection: 'row', gap: 8, alignItems: 'center', flexShrink: 0 },
  spacer: { flexGrow: 1, flexBasis: 0 },
  name: { flexGrow: 1, flexBasis: 0 },
  error: { fontSize: 12 },
  hint: { fontSize: 11 },
});

const KIND_LABEL = { open: 'Open', save: 'Save', folder: 'Select' };

/** `1234567` → `1.2 MB`. Blank for directories and unstat'd entries. */
function humanSize(bytes) {
  if (bytes == null) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 ? n : n.toFixed(1)} ${units[i]}`;
}

/** `{ name, extensions, mimeTypes }` → a predicate over file names. */
function matcher(filter) {
  if (!filter || !filter.extensions?.length) return () => true;
  const exts = filter.extensions.map((e) =>
    String(e)
      .replace(/^[.*]*\.?/, '')
      .toLowerCase(),
  );
  return (name) => {
    const dot = name.lastIndexOf('.');
    if (dot < 0) return false;
    return exts.includes(name.slice(dot + 1).toLowerCase());
  };
}

/**
 * One directory's contents, reloaded whenever the path changes.
 *
 * Errors are state rather than throws: a directory you cannot read is an
 * ordinary thing to click on, and the answer is a message in the dialog, not
 * an error boundary.
 */
function useDirectory(dir) {
  const [state, setState] = useState({ status: 'loading', entries: [] });

  useEffect(() => {
    let live = true;
    setState((prev) => ({ ...prev, status: 'loading' }));
    (async () => {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      let names;
      try {
        names = await fs.readdir(dir, { withFileTypes: true });
      } catch (err) {
        if (live)
          setState({ status: 'error', message: err.message, entries: [] });
        return;
      }
      const withStats = names.length <= STAT_LIMIT;
      const entries = await Promise.all(
        names.map(async (entry) => {
          const full = path.join(dir, entry.name);
          // A symlink's own dirent says 'link'; what matters to the user is
          // what it points at, so follow it and fall back to the link itself
          // when it dangles.
          let directory = entry.isDirectory();
          let size = null;
          let modified = 0;
          if (withStats) {
            try {
              const st = await fs.stat(full);
              directory = st.isDirectory();
              size = directory ? null : st.size;
              modified = st.mtimeMs;
            } catch {
              directory = entry.isDirectory();
            }
          }
          return {
            id: full,
            name: entry.name,
            path: full,
            directory,
            size,
            modified,
          };
        }),
      );
      if (live) setState({ status: 'ready', entries });
    })();
    return () => {
      live = false;
    };
  }, [dir]);

  return state;
}

/**
 * `<FileDialog>` — the built-in file browser.
 *
 * Rendered for you by `useFileDialog()` when there is no portal and no
 * `osascript`; exported because an app that wants this dialog *always* (a
 * kiosk, a test, somewhere the desktop's own dialog is wrong) should not have
 * to break the machine to get it.
 *
 * `onDone(paths | null)` is called exactly once — `null` for cancel.
 */
export function FileDialog({
  kind = 'open',
  title,
  startFolder,
  defaultName = '',
  filters = [],
  multiple = false,
  acceptLabel,
  parentWindow,
  onDone,
  theme: themeProp,
  width = 640,
  height = 460,
}) {
  // `theme` as a prop, because the dialog is often rendered on a **root of its
  // own** (see filedialoghooks.js) where there is no provider above it to
  // inherit from — the palette has to be carried across rather than read.
  const contextTheme = useTheme();
  const theme = themeProp ?? contextTheme;
  const [dir, setDir] = useState(startFolder || process.cwd());
  const [typedPath, setTypedPath] = useState(dir);
  const [name, setName] = useState(defaultName);
  const [showHidden, setShowHidden] = useState(false);
  const [filterId, setFilterId] = useState(filters.length ? '0' : ALL_FILES);
  const [cursor, setCursor] = useState(null);
  const [picked, setPicked] = useState(() => new Set());
  const settled = useRef(false);

  const { status, entries, message } = useDirectory(dir);

  // `onDone` exactly once, however the dialog ends — a caller is awaiting a
  // promise, and settling it twice or not at all are both worse than any
  // rendering bug in here.
  const finish = useCallback(
    (result) => {
      if (settled.current) return;
      settled.current = true;
      onDone?.(result);
    },
    [onDone],
  );

  const activeFilter =
    filterId === ALL_FILES ? null : (filters[Number(filterId)] ?? null);
  const matches = useMemo(() => matcher(activeFilter), [activeFilter]);

  const rows = useMemo(() => {
    const visible = entries.filter((e) => {
      if (!showHidden && e.name.startsWith('.')) return false;
      if (kind === 'folder') return e.directory;
      return e.directory || matches(e.name);
    });
    // Directories first, then by name — the order every file browser uses,
    // and the reason `sort` is passed to Table already applied.
    visible.sort((a, b) =>
      a.directory !== b.directory
        ? a.directory
          ? -1
          : 1
        : a.name.localeCompare(b.name),
    );
    return visible;
  }, [entries, showHidden, matches, kind]);

  // A new directory is a new list; a stale cursor would point at a row that
  // is not there and a stale tick-set would return paths the user cannot see.
  useEffect(() => {
    setCursor(null);
    setPicked(new Set());
    setTypedPath(dir);
  }, [dir]);

  const goUp = useCallback(async () => {
    const path = await import('node:path');
    const parent = path.dirname(dir);
    if (parent !== dir) setDir(parent);
  }, [dir]);

  const toggle = useCallback((row) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(row.path)) next.delete(row.path);
      else next.add(row.path);
      return next;
    });
  }, []);

  const activate = useCallback(
    (id, row) => {
      if (!row) return;
      if (row.directory && kind !== 'folder') return void setDir(row.path);
      if (row.directory && kind === 'folder') return void setDir(row.path);
      if (kind === 'save') return setName(row.name);
      finish([row.path]);
    },
    [kind, finish],
  );

  const accept = useCallback(async () => {
    const path = await import('node:path');
    if (kind === 'save') {
      if (!name.trim()) return;
      return finish([path.resolve(dir, name.trim())]);
    }
    if (kind === 'folder') {
      const chosen = picked.size ? [...picked] : cursor ? [cursor] : [dir]; // no selection means "this one", which is what the path bar shows
      return finish(chosen);
    }
    const chosen =
      multiple && picked.size ? [...picked] : cursor ? [cursor] : [];
    if (!chosen.length) return;
    finish(chosen);
  }, [kind, name, dir, picked, cursor, multiple, finish]);

  const columns = useMemo(() => {
    const cols = [];
    if (multiple && kind !== 'save') {
      cols.push({
        id: 'pick',
        label: '',
        width: 28,
        render: (row) =>
          row.directory
            ? null
            : h(Checkbox, {
                checked: picked.has(row.path),
                onChange: () => toggle(row),
              }),
      });
    }
    cols.push({
      id: 'name',
      label: 'Name',
      width: 300,
      value: (row) => row.name,
      // The accent that marks a directory is the *same value* as the fill the
      // selected row gets — `accent` and `hoverBackground` are one colour in
      // both built-in palettes — so a selected directory was accent on accent
      // and could not be read at all. On the bar the selection's own text
      // colour is the readable one in either scheme, and the trailing `/` is
      // what still says "directory".
      render: (row, { selected }) =>
        h(
          'text',
          {
            style: {
              color: selected
                ? theme.hoverText
                : row.directory
                  ? theme.accent
                  : theme.text,
            },
          },
          row.directory ? `${row.name}/` : row.name,
        ),
    });
    cols.push({
      id: 'size',
      label: 'Size',
      width: 90,
      align: 'right',
      value: (row) => humanSize(row.size),
    });
    cols.push({
      id: 'modified',
      label: 'Modified',
      width: 150,
      value: (row) =>
        row.modified ? new Date(row.modified).toLocaleString() : '',
    });
    return cols;
  }, [multiple, kind, picked, toggle, theme]);

  const filterOptions = [
    ...filters.map((f, i) => ({
      value: String(i),
      label: f.name ?? `Filter ${i + 1}`,
    })),
    { value: ALL_FILES, label: 'All files' },
  ];

  const acceptText =
    acceptLabel ??
    (multiple && picked.size
      ? `${KIND_LABEL[kind]} (${picked.size})`
      : KIND_LABEL[kind]);

  return h(
    'window',
    {
      title: title ?? `${KIND_LABEL[kind]} — react-x11`,
      width,
      height,
      minWidth: 420,
      minHeight: 300,
      transientFor: parentWindow ?? undefined,
      // The palette goes on the window as a **prop** as well as on the context
      // below: a `$token` in a style resolves against the nearest `theme` prop
      // by walking the node tree, which knows nothing about React context.
      theme,
      style: { flexDirection: 'column', backgroundColor: theme.background },
      onCloseRequest: () => finish(null),
      onKeyDown: (e) => {
        if (e.key === 'Escape') finish(null);
      },
    },
    h(
      ThemeProvider,
      { value: theme, style: s.window },

      // Where you are, and the escape hatch for everywhere the list is the slow
      // way round: type a path, press Enter.
      h(
        'box',
        { style: s.bar },
        h(Button, { onPress: goUp }, 'Up'),
        h('textinput', {
          value: typedPath,
          onChange: (e) => setTypedPath(e.value),
          onKeyDown: (e) => {
            if (e.key === 'Enter') setDir(typedPath.trim() || dir);
          },
          style: s.path,
        }),
      ),

      status === 'error'
        ? h(
            'text',
            { style: [s.error, { color: '#dc2626' }] },
            `Cannot read ${dir} — ${message}`,
          )
        : h(Table, {
            columns,
            rows,
            selected: cursor,
            onSelect: (id, row) => {
              setCursor(row?.path ?? null);
              if (multiple && kind !== 'save' && row && !row.directory)
                toggle(row);
              if (kind === 'save' && row && !row.directory) setName(row.name);
            },
            onActivate: activate,
            style: s.list,
          }),

      kind === 'save'
        ? h(
            'box',
            { style: s.bar },
            h('text', null, 'Name'),
            h('textinput', {
              value: name,
              onChange: (e) => setName(e.value),
              onKeyDown: (e) => {
                if (e.key === 'Enter') accept();
              },
              style: s.name,
            }),
          )
        : null,

      h(
        'box',
        { style: s.footer },
        h(Checkbox, {
          checked: showHidden,
          onChange: (e) => setShowHidden(Boolean(e.value)),
          label: 'Show hidden',
        }),
        filters.length
          ? h(Select, {
              options: filterOptions,
              value: filterId,
              onChange: (e) => setFilterId(e.value),
              style: { width: 180 },
            })
          : null,
        h('box', { style: s.spacer }),
        h(Button, { onPress: () => finish(null) }, 'Cancel'),
        h(Button, { primary: true, onPress: accept }, acceptText),
      ),
    ),
  );
}

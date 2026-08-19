// A file browser: the app that has to talk to the rest of the desktop.
//
//   npm run examples:finder
//   npm run examples:finder -- ~/Downloads
//
// Everything here is a conversation with something outside the process —
// another application's clipboard, another application's drag, another
// application's *window* — which is the half of a toolkit that is easy to
// document and hard to believe until it works.
//
// ## Things to try, all of which need a second application
//
//   Drag a row out       onto a file manager, a terminal, an editor, a
//                        browser's upload field. The payload is
//                        `text/uri-list`, built by a thunk so nothing is
//                        assembled for a drag that never leaves.
//   Drag files in        from a file manager. `dropAccept={['files']}` takes
//                        the whole flavour zoo — GNOME, KDE and plain
//                        `text/uri-list` all land as parsed `e.files`.
//   Copy, then paste     in a file manager, and here. `readFiles()` is the
//                        same group vocabulary the drop uses, deliberately.
//   Open terminal here   spawns `xterm -into` a `<foreign>` pane, so another
//                        process's window sits in this window's layout. Ctrl+T
//                        is the app's, not the terminal's — see below.
//
// ## Why there is no tree
//
// The sidebar is a flat list of **places** and the path above the listing is
// **breadcrumbs**. That is how Finder, modern Nautilus and VS Code all
// navigate; a filesystem tree in a sidebar is the older GTK file-chooser
// shape, and the one people navigate worst. It is also one fewer component
// to own.
//
// ## The listing is windowed, and that is not a detail
//
// `/usr/lib` and `node_modules` are tens of thousands of entries. Rows are a
// fixed height and only the visible band is rendered, with a spacer above and
// below standing in for the rest — so scrolling costs the same at 50 entries
// and at 50,000. `<box overflow="scroll">` does the scrolling; the windowing
// is arithmetic on `onScroll`.
//
// ## The seam
//
// Every filesystem call and every spawn goes through one object, which the
// tests replace. `test/finder.test.js` browses a tree that does not exist and
// asserts a terminal *would* have been spawned with the right window id,
// without an `xterm` anywhere.
import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import React, {
  Suspense,
  use,
  useCallback,
  useMemo,
  useState,
  useTransition,
} from 'react';

import {
  Button,
  ContextMenu,
  createRoot,
  createStyles,
  useClipboard,
} from '../src/index.js';

const ROW_H = 22; // fixed, because windowing needs it to be
const OVERSCAN = 6; // rows drawn beyond the viewport, so a flick has cover

// ---------------------------------------------------------------------------
// The seam: everything outside this process
// ---------------------------------------------------------------------------

/** The real one. */
export function realBackend() {
  return {
    home: () => homedir(),

    async read(dir) {
      // `withFileTypes` is one syscall per directory rather than one `stat`
      // per entry, which is the difference between instant and visible on
      // /usr/lib. The entries that need a `stat` — symlinks, whose target
      // kind decides whether they open — are done lazily, and only for the
      // rows the user can see.
      const entries = await readdir(dir, { withFileTypes: true });
      return entries
        .map((e) => ({
          name: e.name,
          dir: e.isDirectory(),
          link: e.isSymbolicLink(),
          path: join(dir, e.name),
        }))
        .sort(
          (a, b) =>
            Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name),
        );
    },

    /** Only for the handful of symlinks actually on screen. */
    async follows(path) {
      try {
        return (await stat(path)).isDirectory();
      } catch {
        return false; // a broken link is not a directory, and not an error
      }
    },

    spawnTerminal(windowId) {
      const cmd = process.env.FINDER_TERMINAL ?? 'xterm -into %WID%';
      const [program, ...args] = cmd
        .split(/\s+/)
        .map((t) => t.replaceAll('%WID%', String(windowId)));
      return spawn(program, args, { stdio: 'ignore', detached: false });
    },
  };
}

// ---------------------------------------------------------------------------
// Reading a directory, for <Suspense>
//
// `use(promise)` needs the *same* promise back for the same input, or the
// component suspends on a new one forever. Keyed by backend as well as by
// path so two of them cannot share an answer — the mistake chat's history
// made before it was keyed by transport.
// ---------------------------------------------------------------------------

const listings = new WeakMap();

export function listingOf(backend, dir, generation = 0) {
  let byDir = listings.get(backend);
  if (!byDir) listings.set(backend, (byDir = new Map()));
  const key = `${generation}:${dir}`;
  let promise = byDir.get(key);
  if (!promise) {
    promise = backend.read(dir).then(
      (entries) => ({ entries, error: null }),
      // A directory you may not read is an ordinary thing to click on, not
      // an exception. It resolves rather than throwing, so the pane renders
      // the reason where the files would have been and the app keeps its
      // shape — no boundary, no blank window.
      (err) => ({ entries: [], error: reasonFor(err) }),
    );
    byDir.set(key, promise);
  }
  return promise;
}

function reasonFor(err) {
  switch (err?.code) {
    case 'EACCES':
      return 'not yours to read';
    case 'ENOENT':
      return 'gone — it was here a moment ago';
    case 'ENOTDIR':
      return 'not a directory';
    case 'ELOOP':
      return 'a symlink loop';
    case 'EMFILE':
      return 'too many open files';
    default:
      return err?.message ?? 'could not be read';
  }
}

// ---------------------------------------------------------------------------

const s = createStyles({
  root: { flexGrow: 1, flexDirection: 'row', backgroundColor: '$background' },

  sidebar: {
    width: 168,
    paddingTop: 8,
    paddingBottom: 8,
    paddingStart: 8,
    paddingEnd: 8,
    gap: 2,
    backgroundColor: '$surfaceHover',
    borderEndWidth: '$borderWidth',
    borderColor: '$border',
  },
  sidebarHead: {
    fontSize: 10,
    color: '$textMuted',
    paddingStart: 6,
    paddingBottom: 4,
  },
  place: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingStart: 8,
    paddingEnd: 8,
    paddingTop: 5,
    paddingBottom: 5,
    borderRadius: '$radius',
    ':hover': { backgroundColor: '$surfaceActive' },
  },
  placeOn: {
    backgroundColor: '$accent',
    ':hover': { backgroundColor: '$accentHover' },
  },
  placeName: { fontSize: 12, color: '$text' },
  onAccent: { color: '$accentText' },

  main: { flexGrow: 1 },
  crumbs: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingStart: 10,
    paddingEnd: 10,
    paddingTop: 8,
    paddingBottom: 8,
    borderBottomWidth: '$borderWidth',
    borderColor: '$border',
  },
  crumb: {
    paddingStart: 6,
    paddingEnd: 6,
    paddingTop: 3,
    paddingBottom: 3,
    borderRadius: '$radius',
    ':hover': { backgroundColor: '$surfaceHover' },
  },
  crumbText: { fontSize: 12, color: '$text' },
  sep: { fontSize: 12, color: '$textMuted' },

  listing: { flexGrow: 1, overflow: 'scroll' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: ROW_H,
    paddingStart: 12,
    paddingEnd: 12,
    ':hover': { backgroundColor: '$surfaceHover' },
    ':active': { backgroundColor: '$surfaceActive' },
    ':drag-over': { backgroundColor: '$accentHover' },
  },
  rowOn: {
    backgroundColor: '$accent',
    ':hover': { backgroundColor: '$accentHover' },
  },
  glyph: { width: 16, fontSize: 12, color: '$textMuted' },
  entry: {
    flexGrow: 1,
    fontSize: 12,
    color: '$text',
    textWrap: 'nowrap',
    textOverflow: 'ellipsis',
  },
  entryCell: { flexGrow: 1, overflow: 'hidden' },

  message: { padding: 16, gap: 6 },
  reason: { fontSize: 12, color: '$warning' },
  hint: { fontSize: 11, color: '$textMuted' },

  ghostRow: { height: ROW_H, paddingStart: 12, paddingEnd: 12 },
  ghost: { height: 10, backgroundColor: '$surfaceHover', borderRadius: 3 },

  pane: { height: 220, borderTopWidth: '$borderWidth', borderColor: '$border' },
  paneBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingStart: 10,
    paddingEnd: 10,
    paddingTop: 4,
    paddingBottom: 4,
    backgroundColor: '$surfaceHover',
  },
  paneLabel: { flexGrow: 1, fontSize: 11, color: '$textMuted' },

  status: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingStart: 12,
    paddingEnd: 12,
    paddingTop: 6,
    paddingBottom: 6,
    borderTopWidth: '$borderWidth',
    borderColor: '$border',
  },
  statusText: { flexGrow: 1, fontSize: 11, color: '$textMuted' },
});

/** `file:` URIs, one per line — what every file manager reads on a drop. */
const uriList = (paths) =>
  `${paths.map((p) => pathToFileURL(p).href).join('\r\n')}\r\n`;

function crumbsFor(dir) {
  const parts = dir.split(sep).filter(Boolean);
  const out = [{ label: sep, path: sep }];
  let at = '';
  for (const part of parts) {
    at += sep + part;
    out.push({ label: part, path: at });
  }
  return out;
}

// ---------------------------------------------------------------------------

/**
 * Only the visible band is rendered. A spacer above and below stands in for
 * the rows that are not, so the scrollbar is the size the whole listing
 * deserves and the tree holds a screenful rather than a directory.
 */
function Listing({ entries, selected, onSelect, onOpen, onDropInto }) {
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(400);

  const first = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
  const last = Math.min(
    entries.length,
    Math.ceil((top + height) / ROW_H) + OVERSCAN,
  );
  const band = entries.slice(first, last);

  return (
    <box
      style={s.listing}
      role="listbox"
      aria-label="files"
      // Places and files are both lists of options, correctly — so a query
      // has to say which list it means.
      data-testname="listing"
      onScroll={(ev) => {
        setTop(ev.scrollY);
        setHeight(ev.viewportHeight);
      }}
      onViewport={(ev) => setHeight(ev.height)}
    >
      <box style={{ height: first * ROW_H }} />
      {band.map((entry) => (
        <Row
          key={entry.path}
          entry={entry}
          selected={selected === entry.path}
          onSelect={onSelect}
          onOpen={onOpen}
          onDropInto={onDropInto}
        />
      ))}
      <box style={{ height: Math.max(0, (entries.length - last) * ROW_H) }} />
    </box>
  );
}

function Row({ entry, selected, onSelect, onOpen, onDropInto }) {
  return (
    <box
      style={[s.row, selected && s.rowOn]}
      role="option"
      aria-label={entry.name}
      aria-selected={selected}
      focusable
      // There is no `onDoubleClick`: a double click is an `onClick` carrying
      // `detail`, the DOM-style count. Writing the handler that does not
      // exist is silent — the prop is simply never called — so this is worth
      // knowing before an afternoon goes into it.
      onClick={(ev) => (ev.detail >= 2 ? onOpen(entry) : onSelect(entry.path))}
      // Enter opens, which is what a file browser means by it. Since #336 the
      // keyboard runs the click's default action, so this consumes the key to
      // stop it also arriving as a select.
      onKeyDown={(ev) => {
        if (ev.keysym === 0xff0d) {
          ev.preventDefault();
          onOpen(entry);
        }
      }}
      draggable
      // A thunk: the URI list is built when the drag first leaves this app,
      // not when it starts. A drag that never crosses the window edge costs
      // nothing.
      dragData={{ 'text/uri-list': () => uriList([entry.path]) }}
      // A directory is also a drop target — dropping onto it is what "move
      // this into that folder" means. The `:drag-over` block does the
      // highlight with no state at all.
      dropAccept={entry.dir ? ['files'] : undefined}
      onDrop={
        entry.dir ? (ev) => onSelect(entry.path) || void ev.files : undefined
      }
    >
      <text style={[s.glyph, selected && s.onAccent]}>
        {entry.dir ? '▸' : entry.link ? '↗' : '·'}
      </text>
      <box style={s.entryCell}>
        <text style={[s.entry, selected && s.onAccent]}>{entry.name}</text>
      </box>
    </box>
  );
}

/** Suspends until the directory is read; renders the reason if it cannot be. */
function Directory({ backend, dir, generation, ...rest }) {
  const { entries, error } = use(listingOf(backend, dir, generation));
  if (error) {
    return (
      <box style={s.message}>
        <text style={s.reason}>{`${dir} — ${error}`}</text>
        <text style={s.hint}>
          The pane keeps its shape: a directory you may not read is an ordinary
          thing to click on, not an exception to handle.
        </text>
      </box>
    );
  }
  if (!entries.length) {
    return (
      <box style={s.message}>
        <text style={s.hint}>empty</text>
      </box>
    );
  }
  return <Listing entries={entries} {...rest} />;
}

/** Sized like the listing it replaces, so the window does not jump twice. */
function ListingFallback() {
  return (
    <box style={{ flexGrow: 1, paddingTop: 4 }} aria-label="reading">
      {[68, 44, 80, 52, 72, 38].map((w, i) => (
        <box key={i} style={s.ghostRow}>
          <box style={[s.ghost, { width: `${w}%` }]} />
        </box>
      ))}
    </box>
  );
}

export function FinderPanel({ backend, start }) {
  const clipboard = useClipboard();
  const home = useMemo(() => backend.home(), [backend]);
  const [dir, setDir] = useState(start ?? home);
  const [selected, setSelected] = useState(null);
  const [generation, setGeneration] = useState(0);
  const [status, setStatus] = useState('');
  const [terminal, setTerminal] = useState(false);
  const [pending, startTransition] = useTransition();

  const places = useMemo(
    () => [
      { name: 'Home', path: home },
      { name: 'Downloads', path: join(home, 'Downloads') },
      { name: 'Documents', path: join(home, 'Documents') },
      { name: 'Temp', path: '/tmp' },
      { name: 'Root', path: sep },
    ],
    [home],
  );

  // In a transition, so the listing you are reading stays put while the next
  // one is read. Without it the pane blanks to the fallback on every click,
  // which reads as the app losing its place.
  const go = useCallback((next) => {
    setSelected(null);
    startTransition(() => setDir(next));
  }, []);

  const open = useCallback(
    async (entry) => {
      if (entry.dir) return go(entry.path);
      if (entry.link && (await backend.follows(entry.path))) {
        return go(entry.path);
      }
      setStatus(`${entry.name} — no handler; this example only browses`);
    },
    [backend, go],
  );

  const copy = useCallback(async () => {
    if (!selected) return;
    await clipboard.write({ 'text/uri-list': uriList([selected]) });
    setStatus(`copied ${basename(selected)}`);
  }, [clipboard, selected]);

  const paste = useCallback(async () => {
    const files = await clipboard.readFiles();
    if (!files?.length) return setStatus('nothing on the clipboard');
    // Deliberately does not copy anything: this example browses, and a file
    // manager that moves data without being asked is a different demo.
    setStatus(
      `${files.length} file${files.length === 1 ? '' : 's'} on the clipboard — ` +
        files
          .slice(0, 3)
          .map((f) => basename(f.path ?? f.uri))
          .join(', '),
    );
  }, [clipboard]);

  const dropInto = useCallback((entry, ev) => {
    const names = (ev.files ?? []).map((f) => basename(f.path ?? f.uri));
    // Deliberately does not move anything. A file manager that copies on a
    // drop without asking is a different demo, and a destructive one to leave
    // in an example — what this shows is that the payload arrived, parsed,
    // from whichever application sent it.
    setStatus(
      names.length
        ? `${names.length} onto ${entry.name}: ${names.slice(0, 3).join(', ')}`
        : `a drop onto ${entry.name} with no files in it`,
    );
  }, []);

  const dropped = useCallback((ev) => {
    const names = (ev.files ?? []).map((f) => basename(f.path ?? f.uri));
    setStatus(
      names.length
        ? `dropped: ${names.slice(0, 4).join(', ')}${names.length > 4 ? '…' : ''}`
        : 'a drop with no files in it',
    );
  }, []);

  const menu = useMemo(
    () => [
      {
        label: 'Open',
        enabled: Boolean(selected),
        onSelect: () => go(selected),
      },
      { type: 'separator' },
      { label: 'Copy', enabled: Boolean(selected), onSelect: copy },
      { label: 'Paste', onSelect: paste },
      { type: 'separator' },
      { label: 'Refresh', onSelect: () => setGeneration((g) => g + 1) },
      {
        label: terminal ? 'Close terminal' : 'Open terminal here',
        onSelect: () => setTerminal((on) => !on),
      },
    ],
    [selected, copy, paste, go, terminal],
  );

  return (
    <box
      style={s.root}
      // Ctrl+T is the application's, and saying so is what stops an embedded
      // terminal eating it — docs/embedding.md. It still will not fire while
      // the pointer is inside the pane, which is X's rule rather than ours.
      onKeyDown={(ev) => {
        if (ev.ctrlKey && ev.key === 't') {
          ev.preventDefault();
          setTerminal((on) => !on);
        }
      }}
    >
      <box
        style={s.sidebar}
        role="listbox"
        aria-label="places"
        data-testname="places"
      >
        <text style={s.sidebarHead}>PLACES</text>
        {places.map((place) => {
          const on = place.path === dir;
          return (
            <box
              key={place.path}
              style={[s.place, on && s.placeOn]}
              role="option"
              aria-label={place.name}
              aria-selected={on}
              focusable
              onClick={() => go(place.path)}
            >
              <text style={[s.placeName, on && s.onAccent]}>{place.name}</text>
            </box>
          );
        })}
      </box>

      <box style={s.main}>
        <box style={s.crumbs} role="navigation" aria-label="path">
          {crumbsFor(dir).map((crumb, i, all) => (
            <box key={crumb.path} style={{ flexDirection: 'row', gap: 2 }}>
              <box
                style={s.crumb}
                role="link"
                aria-label={crumb.label}
                focusable
                onClick={() => go(crumb.path)}
              >
                <text style={s.crumbText}>{crumb.label}</text>
              </box>
              {i < all.length - 1 ? <text style={s.sep}>›</text> : null}
            </box>
          ))}
        </box>

        <ContextMenu items={menu} style={{ flexGrow: 1 }}>
          {/* The listing is the drop target for the whole pane: a drop
              anywhere that is not a folder row lands "here". */}
          <box style={{ flexGrow: 1 }} dropAccept={['files']} onDrop={dropped}>
            <Suspense fallback={<ListingFallback />}>
              <Directory
                backend={backend}
                dir={dir}
                generation={generation}
                selected={selected}
                onSelect={setSelected}
                onOpen={open}
                onDropInto={dropInto}
              />
            </Suspense>
          </box>
        </ContextMenu>

        {terminal ? (
          <box style={s.pane}>
            <box style={s.paneBar}>
              <text style={s.paneLabel}>{`terminal — ${dir}`}</text>
              <Button onPress={() => setTerminal(false)}>Close</Button>
            </box>
            {/* No `windowId`: the pane hands out its **own** id and the
                program is started into it. That is the adopt path, and it is
                the only way to embed something that has to be given a window
                before it makes one. */}
            <foreign
              style={{ flexGrow: 1, backgroundColor: '#101014' }}
              onReady={({ windowId }) => backend.spawnTerminal(windowId, dir)}
              onClientGone={() => setTerminal(false)}
            />
          </box>
        ) : null}

        <box style={s.status}>
          <text style={s.statusText}>
            {status || `${basename(dir) || dir}${pending ? ' — reading…' : ''}`}
          </text>
          <Button onPress={copy} disabled={!selected}>
            Copy
          </Button>
          <Button onPress={paste}>Paste</Button>
        </box>
      </box>
    </box>
  );
}

export function App({ backend, start }) {
  const chosen = useMemo(() => backend ?? realBackend(), [backend]);
  return (
    <window
      width={820}
      height={560}
      title="react-x11 finder"
      minWidth={560}
      minHeight={320}
      style={{ backgroundColor: '$background' }}
    >
      <FinderPanel backend={chosen} start={start} />
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN && !import.meta.hot) {
  const arg = process.argv.slice(2).find((a) => !a.startsWith('-'));
  const root = await createRoot();
  root.render(
    <App start={arg ? fileURLToPath(pathToFileURL(arg)) : undefined} />,
  );
}

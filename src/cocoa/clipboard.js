// The clipboard on the cocoa backend: ntk's `app.clipboard` shape over
// `NSPasteboard.general`, which is what src/clipboard.js and the text
// controls call.
//
// ## One pasteboard, and it is CLIPBOARD's
//
// X's other everyday selection, PRIMARY, is taken by *selecting text at all*
// and pasted with a middle click, and core takes it on every selection
// gesture (textselection.js `own()`, the text controls' `_ownSelection`).
// Sent to the pasteboard, each of those gestures was a Copy: a drag across a
// paragraph replaced the link the user had just copied in another app.
//
// So every other name — PRIMARY, SECONDARY, one of the app's own — is a
// selection nobody on this desktop can paste from: a write resolves and
// changes nothing, a read finds no owner, `targets()` is empty, `clear()`
// leaves the pasteboard alone and `watch()` never fires. Deliberately not a
// PRIMARY kept in this process: its point is the paste in *another*
// application, and inside one all it would keep is a middle click that types
// into a text field, which no Mac text field does. An app that wants
// select-to-copy anyway — a terminal — writes CLIPBOARD from
// `onSelectionChange` (docs/clipboard.md, "Two clipboards").
//
// ## Reading what is there
//
// `targets()` and `read({ target })` see the pasteboard's items and the
// types each offers, in react-x11's vocabulary (dnd.js's table, then the
// system's): `public.png` is `image/png`, text is the X names and the MIME
// ones at once, and a type with no MIME type keeps its own name — which is
// how `org.nspasteboard.ConcealedType`, the marker a password manager puts
// beside a secret so clipboard tools leave it out of their history, reaches
// an app that wants to honour it. Two rungs, the way the file dialog and the
// notifications have them:
//
// 1. **`pasteboardItems()` and `pasteboardItemData(index, type)` on the
//    bridge**, where it has them — the general pasteboard's twins of the
//    drag pasteboard's `dragItems`/`dragItemData`, and asked the same way: in
//    the call on the main thread, through a callback from a worker.
// 2. **`osascript -l JavaScript`** beneath them: the same two questions asked
//    of `NSPasteboard` through the scripting bridge, one short-lived child
//    each — about 60 ms of wall clock and as much CPU. Affordable because nothing
//    asks it on a clock: a `targets()` or a `read()` the app made, and one
//    per change while something is watching; and the item list is kept
//    against the change count, so a second `targets()` with nothing copied
//    in between asks nobody.
//
// Text is neither: `pasteboardReadText`, the verb every bridge has, answers
// a text read on both rungs, so a paste in a text field never waits on a
// child process.
//
// ## Knowing when it changes
//
// Nothing announces a write to the pasteboard — macOS has no counterpart of
// XFixes' selection events — so `watch()` asks `NSPasteboard.changeCount`,
// which every write bumps, every `WATCH_POLL_MS` while something is watching
// and never otherwise (#937). `pasteboardChangeCount()` is a published copy
// on a worker (the bridge re-reads it on that same quarter second) and a
// call into AppKit on the main thread; either is under a microsecond. A bridge
// without it rejects the watch, the way an X server without XFixes does, and
// the edit menu's Paste row stays enabled there, which is where it started.

import { TEXT_TARGETS } from '../transfer.js';
import { mimeFromUti, utiFromMime, wire } from './dnd.js';

/** CLIPBOARD, named or by default: the one selection that is the pasteboard. */
const isClipboard = (selection = 'CLIPBOARD') => selection === 'CLIPBOARD';

const TEXT = 'public.utf8-plain-text';
const FILE_URL = 'public.file-url';
const URL_TYPE = 'public.url';

/**
 * How often a watched pasteboard's change count is asked, in ms. The bridge
 * republishes it for a worker on the same quarter second, so asking faster
 * there would only read the same number again; and a quarter second is under
 * the time it takes to move from the app that copied to a menu in this one.
 */
export const WATCH_POLL_MS = 250;

/** What text on the pasteboard is called here: its MIME names and X's, best
 * first, so `read('text')` and `readText()` both find it. */
const TEXT_NAMES = TEXT_TARGETS.filter(
  (t) => t !== 'TEXT' && t !== 'COMPOUND_TEXT',
);

/** A reverse-DNS type identifier. The pasteboard also carries the legacy
 * names AppKit still hands out (`NSStringPboardType`, `Apple PNG pasteboard
 * type`), which name nothing an app could ask for. */
const isUti = (type) => /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(type);

/** Where `owner` would name a window on X11: the pasteboard has content, and
 * no window of anybody's owns it. Never 0, which is "nothing to paste". */
export const PASTEBOARD_OWNER = -1;

/**
 * The pasteboard's types — every item's, in the order the writer offered
 * them — as the target names `targets()` answers with.
 */
export function pasteboardTargets(types, native) {
  const out = [];
  const add = (t) => t && !out.includes(t) && out.push(t);
  for (const type of types) {
    if (type === TEXT) {
      for (const name of TEXT_NAMES) add(name);
      continue;
    }
    const mime = mimeFromUti(type, native);
    if (mime) add(mime);
    // a dynamic type with no MIME type behind it is no name anybody could
    // have asked for: it is the system's hash of one
    else if (isUti(type) && !type.startsWith('dyn.')) add(type);
  }
  return out;
}

/** The pasteboard types a target is read from, best first. */
function typesFor(target, native) {
  if (target === 'text/uri-list') return [FILE_URL, URL_TYPE];
  const uti = utiFromMime(target, native);
  if (uti) return [uti];
  return isUti(target) ? [target] : [];
}

// --- the osascript rung --------------------------------------------------------

/** The pasteboard through the scripting bridge: `items` answers the change
 * count and each item's types, `data <type>` each item's bytes of it. */
const JXA = `ObjC.import('AppKit');
function run(argv) {
  const pb = $.NSPasteboard.generalPasteboard;
  const items = ObjC.unwrap(pb.pasteboardItems) || [];
  if (argv[0] === 'items') {
    return JSON.stringify({
      count: Number(pb.changeCount),
      items: items.map((item) => ObjC.deepUnwrap(item.types) || []),
    });
  }
  return JSON.stringify(items.map((item) => {
    const data = item.dataForType(argv[1]);
    return data.isNil() ? null : data.base64EncodedStringWithOptions(0).js;
  }));
}`;

const OSASCRIPT = '/usr/bin/osascript';

/**
 * Test seam, not public: what runs `osascript`, as `(file, args) =>
 * Promise<stdout>`. A fake here lets the rung run off a Mac, and lets a test
 * on one leave the real pasteboard alone.
 */
let runOsascript = null;
export function _setOsascriptForTests(fn) {
  runOsascript = fn;
}

async function execOsascript(file, args) {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      // an image on the pasteboard comes back as base64 on stdout
      { encoding: 'utf8', timeout: 10_000, maxBuffer: 512 * 1024 * 1024 },
      (err, out) => (err ? reject(err) : resolve(String(out ?? ''))),
    );
  });
}

const jxa = async (...args) =>
  JSON.parse(
    await (runOsascript ?? execOsascript)(OSASCRIPT, [
      '-l',
      'JavaScript',
      '-e',
      JXA,
      ...args,
    ]),
  );

const toBuffer = (value) =>
  value == null
    ? null
    : typeof value === 'string'
      ? Buffer.from(value, 'utf8')
      : Buffer.from(value);

// --- the clipboard -------------------------------------------------------------

export class CocoaClipboard {
  constructor(app, native) {
    this._app = app;
    this._native = native;
    this._warnedFlavours = false;
    this._warnedRead = false;
    // the osascript rung's last item list, and the change count it is for
    this._cached = null;
    this._watchers = new Set();
    this._timer = null;
    this._lastCount = null;
    this._checking = false;
  }

  /**
   * A write is one pasteboard item with every flavour under its UTI —
   * dnd.js's table, then the system's — the way a drag offers its payload.
   * Text alone keeps pasteboardWriteText, the verb every bridge has;
   * anything else needs pasteboardWrite (windowkit/appkit#119), and a bridge
   * without it keeps the text and says, once, what it dropped — an image
   * that silently never reaches the pasteboard looks like a Copy that did
   * nothing.
   */
  write(data, { selection } = {}) {
    const native = this._native;
    if (!isClipboard(selection)) return Promise.resolve();
    if (typeof data === 'string') {
      native.pasteboardWriteText(data);
      return Promise.resolve();
    }
    const item = {};
    for (const [type, value] of Object.entries(data ?? {})) {
      const uti = utiFromMime(type, native);
      if (uti && value != null && !(uti in item)) item[uti] = wire(value);
    }
    const raw = item[TEXT];
    const text =
      raw == null
        ? ''
        : typeof raw === 'string'
          ? raw
          : Buffer.from(raw).toString('utf8');
    const others = Object.keys(item).filter((uti) => uti !== TEXT);
    if (others.length === 0) {
      native.pasteboardWriteText(text);
    } else if (typeof native.pasteboardWrite === 'function') {
      native.pasteboardWrite(item);
    } else {
      if (!this._warnedFlavours && process.env.NODE_ENV !== 'production') {
        this._warnedFlavours = true;
        console.warn(
          `react-x11: clipboard.write() kept only the text — this ` +
            `@windowkit/appkit has no pasteboardWrite, so ` +
            `${others.join(', ')} did not reach the pasteboard. ` +
            'Update @windowkit/appkit to a release with pasteboardWrite ' +
            '(windowkit/appkit#119).',
        );
      }
      native.pasteboardWriteText(text);
    }
    return Promise.resolve();
  }

  clear(selection) {
    if (isClipboard(selection)) this._native.pasteboardClear();
    return Promise.resolve();
  }

  async targets({ selection } = {}) {
    if (!isClipboard(selection)) return [];
    let items;
    try {
      items = await this._items();
    } catch (err) {
      // No rung could list the types. The text is still worth reporting:
      // it is what this answered before there were rungs at all.
      this._warnRead(err);
      const text = await this._app._ask('pasteboardReadText');
      return text == null ? [] : [...TEXT_NAMES];
    }
    return pasteboardTargets(items.flat(), this._native);
  }

  async read({ selection, target } = {}) {
    if (!isClipboard(selection)) {
      throw new Error(
        `clipboard: nothing to paste — ${selection} is an X11 ` +
          'selection, and on macOS only CLIPBOARD is the pasteboard',
      );
    }
    if (target === undefined || TEXT_TARGETS.includes(target)) {
      const text = await this._app._ask('pasteboardReadText');
      if (text == null) {
        throw new Error(
          'clipboard: nothing to paste — the pasteboard is empty',
        );
      }
      return target === undefined ? text : Buffer.from(text, 'utf8');
    }
    let empty = true;
    for (const type of typesFor(target, this._native)) {
      let values;
      try {
        values = await this._dataOf(type);
      } catch (err) {
        this._warnRead(err);
        throw new Error(
          `clipboard: cannot read ${target} from the pasteboard — ` +
            `${err?.message ?? err}`,
        );
      }
      if (values.length) empty = false;
      const present = values.filter((v) => v != null);
      if (!present.length) continue;
      // A Finder copy of three files is three items of one URL each; a
      // uri-list is how the rest of react-x11 hears about several files.
      if (type === FILE_URL || type === URL_TYPE) {
        return Buffer.from(
          present.map((v) => v.toString('utf8')).join('\r\n') + '\r\n',
        );
      }
      return present[0];
    }
    throw new Error(
      empty
        ? 'clipboard: nothing to paste — the pasteboard is empty'
        : `clipboard: cannot convert the pasteboard to ${target}`,
    );
  }

  /**
   * `handler` with ntk's `SelectionChange` whenever the pasteboard's change
   * count moves: `owner` 0 when it was left empty and `PASTEBOARD_OWNER`
   * when it holds anything, `changeCount` the pasteboard's own count. Copies
   * closer together than one poll are one change.
   */
  watch(selection, handler) {
    if (typeof handler !== 'function') {
      return Promise.reject(
        new TypeError('clipboard: watch needs a handler function'),
      );
    }
    if (!isClipboard(selection)) return Promise.resolve(() => {});
    if (typeof this._native.pasteboardChangeCount !== 'function') {
      return Promise.reject(
        new Error(
          'clipboard: this @windowkit/appkit has no pasteboardChangeCount, ' +
            'so pasteboard changes cannot be watched — update ' +
            '@windowkit/appkit',
        ),
      );
    }
    const entry = { handler };
    if (!this._watchers.size) this._startPolling();
    this._watchers.add(entry);
    let stopped = false;
    return Promise.resolve(() => {
      if (stopped) return;
      stopped = true;
      this._watchers.delete(entry);
      if (!this._watchers.size) this._stopPolling();
    });
  }

  /** Stop asking; the app is closing. */
  close() {
    this._watchers.clear();
    this._stopPolling();
  }

  // --- internals ---------------------------------------------------------------

  _changeCount() {
    if (typeof this._native.pasteboardChangeCount !== 'function') return null;
    const count = this._native.pasteboardChangeCount();
    return typeof count === 'number' ? count : null;
  }

  _hasItemVerbs() {
    const native = this._native;
    return (
      typeof native.pasteboardItems === 'function' &&
      typeof native.pasteboardItemData === 'function'
    );
  }

  /** Each item on the pasteboard, as the types it offers. */
  async _items() {
    if (this._hasItemVerbs()) {
      const items = await this._app._ask('pasteboardItems');
      return Array.isArray(items)
        ? items.map((item) => (Array.isArray(item?.types) ? item.types : []))
        : [];
    }
    const count = this._changeCount();
    if (count != null && this._cached?.count === count) {
      return this._cached.items;
    }
    const answer = await jxa('items');
    const items = Array.isArray(answer?.items) ? answer.items : [];
    this._cached = { count: answer?.count, items };
    return items;
  }

  /** Each item's bytes of `type`, null where an item has none. */
  async _dataOf(type) {
    if (this._hasItemVerbs()) {
      const items = await this._items();
      const values = await Promise.all(
        items.map((types, index) =>
          types.includes(type)
            ? this._app._ask('pasteboardItemData', index, type)
            : null,
        ),
      );
      return values.map(toBuffer);
    }
    const values = await jxa('data', type);
    return Array.isArray(values)
      ? values.map((v) => (v == null ? null : Buffer.from(v, 'base64')))
      : [];
  }

  /** A Mac always has `osascript`, so one that cannot run it is a sandbox or
   * a stripped image, and the clipboard would read as text-only there with
   * nothing to say why. Said once, in development. */
  _warnRead(err) {
    if (this._warnedRead || process.env.NODE_ENV === 'production') return;
    this._warnedRead = true;
    console.warn(
      'react-x11: the clipboard cannot list what is on the pasteboard — ' +
        'this @windowkit/appkit has no pasteboardItems, and ' +
        `\`${OSASCRIPT}\` failed: ${err?.message ?? err}. targets() ` +
        'reports text alone meanwhile, and a read of anything else rejects.',
    );
  }

  _startPolling() {
    this._lastCount = this._changeCount();
    this._timer = setInterval(() => this._poll(), WATCH_POLL_MS);
    // a watch never holds the process open, as an X subscription does not
    this._timer.unref?.();
  }

  _stopPolling() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this._lastCount = null;
  }

  _poll() {
    // one question about the contents at a time; a change during it is
    // still a change when it is over, since the count is compared again
    if (this._checking) return;
    const count = this._changeCount();
    if (count == null || count === this._lastCount) return;
    this._lastCount = count;
    this._checking = true;
    this._holdsAnything()
      .then((full) => {
        if (!this._timer) return;
        const change = {
          selection: 'CLIPBOARD',
          owner: full ? PASTEBOARD_OWNER : 0,
          reason: 'new-owner',
          changeCount: count,
        };
        // a throwing handler must not cost the others their event
        for (const { handler } of [...this._watchers]) {
          try {
            handler(change);
          } catch (err) {
            console.warn(
              `react-x11: clipboard watch handler threw: ${err?.message ?? err}`,
            );
          }
        }
      })
      .finally(() => {
        this._checking = false;
      });
  }

  /** Whether a paste would find anything. Unknown means yes, as it does in
   * src/pastestate.js: a Paste row left enabled does nothing worse than
   * paste nothing. */
  async _holdsAnything() {
    try {
      return (await this._items()).some((types) => types.length > 0);
    } catch {
      try {
        return (await this._app._ask('pasteboardReadText')) != null;
      } catch {
        return true;
      }
    }
  }
}

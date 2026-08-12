// The clipboard an application sees.
//
// ntk's `app.clipboard` is the ICCCM selection machinery: it owns
// selections, answers conversions, and speaks INCR. This is the layer above
// it, and it adds exactly three things, none of which belong upstream:
//
//   1. the type vocabulary (transfer.js) — so `read('text')` finds GTK's
//      UTF8_STRING and `readFiles()` parses a file manager's uri-list,
//      instead of every app rediscovering the same table;
//   2. an ICCCM timestamp by default (inputtime.js), so a copy is stamped
//      with the keystroke that caused it rather than with "now";
//   3. a way in from React (useClipboard), since a component has no route
//      to the connection.
//
// Everything on the wire is still ntk's. `root.app.clipboard` remains the
// documented escape hatch for anything this does not cover.

import { lastInputTime } from './inputtime.js';
import { decodeData, parseUriList, resolveType } from './transfer.js';

/** Ask the owner what it has, so a group name can be resolved against a
 * real offer rather than guessed at one failed conversion per guess. */
async function offeredTypes(clipboard, options) {
  try {
    return await clipboard.targets(options);
  } catch {
    return [];
  }
}

/**
 * The object `useClipboard()` hands back. One per app — it holds no state
 * of its own, so making a second is harmless.
 */
export function createClipboard(app) {
  const raw = () => {
    const c = app?.clipboard;
    if (!c) throw new Error('react-x11: this app has no clipboard');
    return c;
  };
  // every call takes the same three, and every one of them has a default
  // worth not repeating
  const opts = ({ selection = 'CLIPBOARD', timeout, time } = {}) => ({
    selection,
    ...(timeout === undefined ? {} : { timeout }),
    time: time === undefined ? lastInputTime(app) : time,
  });

  return {
    /** Take a selection and serve `data` — a string, or a map of type name
     * to string/bytes for offering several flavours of one thing. */
    write(data, options) {
      return raw().write(data, opts(options));
    },

    /** Shorthand for the common case; offered as UTF8_STRING and STRING. */
    writeText(text, options) {
      return raw().write(String(text), opts(options));
    },

    /** Give the selection back, so nothing is served for it any more. */
    clear(selection = 'CLIPBOARD') {
      return raw().clear(selection);
    },

    /** What the current owner can convert to. `[]` when nothing owns it. */
    targets(options) {
      return raw().targets(opts(options));
    },

    /** The plain text of a selection, ntk's UTF8_STRING → STRING walk.
     * `read('text')` is the interop-hardened version of this. */
    readText(options) {
      return raw().read(opts(options));
    },

    /**
     * One type, decoded: a concrete name (`'image/png'`) or a group
     * (`'text'`, `'files'`, `'uris'`) resolved against what the owner
     * actually offers. Text-ish types come back as a string, everything
     * else as bytes. `null` when the owner has nothing of that kind —
     * which is a question, not an error, unlike `readText()` on an empty
     * clipboard.
     */
    async read(type, options) {
      const o = opts(options);
      const offered = await offeredTypes(raw(), o);
      const target = resolveType(type, offered);
      if (!offered.includes(target)) return null;
      const data = await raw().read({ ...o, target });
      return typeof data === 'string' ? data : decodeData(data, target);
    },

    /**
     * Files copied in a file manager, parsed (RFC 2483). `[]` when the
     * clipboard holds no file flavour, so a paste handler can call it
     * without asking first.
     */
    async readFiles(options) {
      const list = await this.read('files', options);
      return typeof list === 'string' ? parseUriList(list) : [];
    },

    /**
     * Call `handler` whenever the selection changes hands — an XFixes
     * subscription, not a poll. `ev.owner === 0` means nothing is on the
     * clipboard, which is the case an edit menu wants.
     *
     * Rejects on a server without XFixes; every X server since about 2004
     * has it, so treat that as "this server is unusual" rather than as a
     * path to code around.
     */
    watch(selectionOrHandler, maybeHandler) {
      const [selection, handler] =
        typeof selectionOrHandler === 'function'
          ? ['CLIPBOARD', selectionOrHandler]
          : [selectionOrHandler, maybeHandler];
      return raw().watch(selection, handler);
    },
  };
}

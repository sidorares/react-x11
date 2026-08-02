// The type vocabulary, shared by the clipboard and drag and drop.
//
// The same logical payload arrives under different names depending on who
// sent it: files are text/uri-list (plus desktop-specific variants), GTK
// text is text/plain;charset=utf-8 / UTF8_STRING / STRING / COMPOUND_TEXT,
// Firefox links are UTF-16 text/x-moz-url, Chromium's are _NETSCAPE_URL.
// String equality on 'text/plain' misses GTK text entirely — normalising
// this once is the interop feature.
//
// It lives here rather than in dnd.js because a paste and a drop face the
// identical soup: the X selection a file manager offers on CLIPBOARD is the
// one it offers on XdndSelection. One vocabulary, two gestures — the same
// split GTK draws with GdkContentFormats and Qt with QMimeData.

/** Best-first text flavours, for `e.text` and the 'text' group. */
export const TEXT_TARGETS = [
  'text/plain;charset=utf-8',
  'UTF8_STRING',
  'text/plain',
  'STRING',
  'TEXT',
  'COMPOUND_TEXT',
];

export const TYPE_GROUPS = {
  files: [
    'text/uri-list',
    'application/x-kde4-urilist',
    'x-special/gnome-copied-files',
  ],
  uris: ['text/uri-list', 'text/x-moz-url', '_NETSCAPE_URL'],
  text: TEXT_TARGETS,
};

/** Does the offered type list satisfy one accept entry — a semantic group
 * ('files' | 'uris' | 'text') or a concrete type name? MIME names compare
 * case-insensitively; X atom names like UTF8_STRING are exact. */
export function typeMatches(offered, want) {
  const group = TYPE_GROUPS[want];
  if (group) return group.some((t) => offered.includes(t));
  if (offered.includes(want)) return true;
  const lower = String(want).toLowerCase();
  return offered.some((t) => t.toLowerCase() === lower);
}

/**
 * A group name resolved against what is actually on offer: the first
 * member of the group the owner can convert to, in the group's own
 * preference order. A concrete type is returned unchanged, so callers can
 * pass either without asking which they have.
 */
export function resolveType(type, offered) {
  const group = TYPE_GROUPS[type];
  if (!group) return type;
  return group.find((t) => offered.includes(t)) ?? type;
}

/** Bytes from a selection, decoded when the target says they are text.
 * STRING is latin-1 by definition; everything else text-ish is UTF-8. */
export function decodeData(data, target) {
  const textish =
    TEXT_TARGETS.includes(target) || /^text\//i.test(String(target));
  if (!textish) return data;
  return data.toString(target === 'STRING' ? 'latin1' : 'utf8');
}

/**
 * Parse a `text/uri-list` payload (RFC 2483): CRLF-separated, `#` lines are
 * comments, URIs are percent-encoded. `path` is present only for `file:`
 * URIs that are actually local — a remote `file://host/...` has no local
 * path and must not pretend to.
 */
export function parseUriList(text) {
  const files = [];
  for (const line of String(text).split(/\r?\n/)) {
    const uri = line.trim();
    if (!uri || uri.startsWith('#')) continue;
    const entry = { uri };
    try {
      const url = new URL(uri);
      if (
        url.protocol === 'file:' &&
        (url.hostname === '' || url.hostname === 'localhost')
      ) {
        entry.path = decodeURIComponent(url.pathname);
      }
    } catch {
      // not a parseable URI — keep the raw line, claim no path
    }
    files.push(entry);
  }
  return files;
}

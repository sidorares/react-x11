// Type-ahead matching shared by Select and the menus.

import { useCallback, useRef } from 'react';

export const TYPE_AHEAD_TIMEOUT = 700;

/**
 * Type-ahead: typing letters jumps to the entry whose label starts with
 * them. Shared by `Select` and the menus.
 *
 * Keystrokes within `timeout` accumulate into one query, so "ca" finds
 * Carrot rather than jumping to Apple then Carrot. Two behaviours the
 * platform conventions call for:
 *
 * - a growing query searches from the *current* entry, so refining a
 *   prefix keeps you on it while it still matches;
 * - repeating one letter ("c", "c", "c") cycles through the entries
 *   starting with it instead of sticking on the first.
 *
 * Returns the matching index, or -1.
 */
export function useTypeAhead(timeout = TYPE_AHEAD_TIMEOUT) {
  const state = useRef({ text: '', at: 0 });
  return useCallback(
    (char, items, current, labelOf, selectable) => {
      if (!char || char.length !== 1) return -1;
      const now = Date.now();
      const s = state.current;
      s.text = now - s.at > timeout ? char : s.text + char;
      s.at = now;

      const query = s.text.toLowerCase();
      const cycling = query.length > 1 && /^(.)\1+$/.test(query);
      const needle = cycling ? query[0] : query;
      const from =
        cycling || query.length === 1 ? (current ?? -1) + 1 : (current ?? 0);

      const n = items.length;
      for (let k = 0; k < n; k++) {
        const i = (((from + k) % n) + n) % n;
        const item = items[i];
        if (selectable && !selectable(item)) continue;
        const label = String(labelOf(item) ?? '').toLowerCase();
        if (label.startsWith(needle)) return i;
      }
      return -1;
    },
    [timeout],
  );
}

/**
 * A printable character usable for type-ahead. Space is excluded: it
 * activates the focused entry everywhere in this widget set.
 *
 * So is anything held down with Control, Alt or Super. A chord is a command
 * rather than a letter — the key still *types* an `s` under Ctrl+S — and a
 * menu that answered Ctrl+S by jumping its selection to "Save As…" was both
 * doing the wrong thing and consuming the key on its way to the accelerator
 * that meant to answer it (#351). Shift is not in the list: Shift+A is a
 * letter.
 */
export function typeAheadChar(ev) {
  if (ev.ctrlKey || ev.altKey || ev.metaKey) return null;
  return ev.key && ev.key.length === 1 && ev.codepoint > 32 ? ev.key : null;
}

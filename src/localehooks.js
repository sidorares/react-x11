// `useLocale()` — the language and conventions the app was started in.
//
// The resolution lives in `locale.js`. There is no store and no subscription
// behind this: a process's locale is fixed at exec (see the note there), so
// the hook exists for composition and discoverability rather than because
// anything can change.

import { systemLocale } from './locale.js';

/**
 * Which language and conventions this app was started in.
 *
 * ```jsx
 * const { locale, weekStartsOn } = useLocale();
 *
 * <Calendar locale={locale} weekStartsOn={weekStartsOn} />
 * <text>{new Intl.NumberFormat(locale).format(total)}</text>
 * ```
 *
 * | | |
 * | --- | --- |
 * | `locale` | a BCP-47 tag: `'en-GB'`, `'ru-RU'` |
 * | `direction` | `'ltr'` or `'rtl'` — what the default theme is already seeded with |
 * | `weekStartsOn` | `0` Sunday … `6` Saturday, from CLDR |
 * | `timeZone` | `'Europe/London'`, or null where ICU could not say |
 * | `source` | `'env'` when `LANG` and friends said, `'intl'` when ICU did |
 *
 * **`LC_ALL` / `LC_MESSAGES` / `LANG` win over `Intl`'s own answer**, because
 * ICU resolves to what it has compiled in rather than to what the user asked
 * for — a small-ICU node reports `en-US` for every environment there is. The
 * tag here is what the person who launched the app said; `Intl` is the
 * fallback for a process started without any of them.
 *
 * **This does not change while the app runs**, and there is deliberately no
 * subscription: a process's environment is fixed at exec and ICU's resolution
 * with it, so a desktop that switches language announces it for the *next*
 * login and nothing this process can observe has moved.
 *
 * Text direction is here for completeness and is rarely what you want to read
 * — the widget set already mirrors itself from the same value, and
 * `useDirection()` is the one to ask inside a component, because it also
 * honours a `<ThemeProvider direction>` and a `direction` style property the
 * locale knows nothing about. See docs/styling.md.
 */
export function useLocale() {
  return systemLocale();
}

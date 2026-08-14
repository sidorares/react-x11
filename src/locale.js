// Which language and conventions this app was started in.
//
// ## Why the environment comes before `Intl`
//
// `Intl.DateTimeFormat().resolvedOptions().locale` is the obvious answer and
// it is the *second* one here, because node resolves it through ICU and ICU
// answers `en-US` for a great many environments that are not en-US — a
// small-ICU build has one locale compiled in, and a container with `LANG`
// set but no locale archive still tells you what the user asked for. POSIX
// `LC_ALL` / `LC_MESSAGES` / `LANG` is what the person who launched the app
// actually said, so it wins where it says anything.
//
// `C` and `POSIX` are not locales — they are the *absence* of one, spelled
// as a value — so they fall through rather than being converted to a tag.
//
// ## This does not change while an app runs
//
// A process's environment is fixed at exec, and `Intl`'s resolution with it.
// `org.freedesktop.locale1` can announce a change for *future* logins, and
// neither node nor ICU picks it up for this one, so publishing it here would
// be reporting a change that has not happened to anything the app can see.
//
// So `useLocale()` subscribes to nothing, the way `useSupports('shaders')`
// does — the hook shape is for composition and for the day a rung underneath
// it can genuinely change, not because there is a store behind it.

import { localeDirection } from './palette.js';

const ENV = typeof process === 'undefined' ? {} : (process.env ?? {});

/**
 * A POSIX locale string → a BCP-47 tag, or null when it is not a locale.
 *
 * `ru_RU.UTF-8@euro` → `ru-RU`: the codeset after `.` and the modifier after
 * `@` are POSIX's and mean nothing to `Intl`, and the territory separator is
 * `_` where BCP-47 wants `-`.
 *
 * Pure, and exported for the test.
 */
export function toLanguageTag(value) {
  if (typeof value !== 'string') return null;
  const bare = value.split('.')[0].split('@')[0].trim().replace(/_/g, '-');
  if (!bare) return null;
  // The two values that mean "no locale at all". Passing either to `Intl`
  // gets a RangeError from `C` and, worse, a plausible-looking `posix` tag
  // from the other.
  if (/^(C|POSIX)$/i.test(bare)) return null;
  try {
    // Canonicalises case and rejects a malformed tag — a `LANG` of
    // `en_US_POSIX` or a typo should fall through to ICU rather than reach a
    // formatter and throw there.
    return Intl.getCanonicalLocales(bare)[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Which day the week starts on for a locale: `0` Sunday … `6` Saturday.
 *
 * The runtime knows this — CLDR carries it — but only through
 * `Intl.Locale#getWeekInfo`, which is recent enough that a small-ICU build or
 * an older V8 has neither it nor the `weekInfo` property it was proposed as.
 * So it is feature-detected, and what is left when it is missing is **Monday**:
 * ISO 8601's answer, and the one most of the world uses.
 */
export function localeWeekStart(locale) {
  try {
    const info = new Intl.Locale(locale ?? undefined);
    const week = info.getWeekInfo?.() ?? info.weekInfo;
    // CLDR counts 1 Monday … 7 Sunday; JS counts 0 Sunday … 6 Saturday
    if (week?.firstDay) return week.firstDay % 7;
  } catch {
    // an invalid locale tag: the caller's formatters will complain about it
    // more usefully than a week-start fallback could
  }
  return 1;
}

/**
 * Which way a tag reads.
 *
 * CLDR knows, through `Intl.Locale#getTextInfo()`, and that is the answer
 * where the runtime has it — it covers every script rather than the list of
 * languages a hand-maintained set can hold. `localeDirection()` in
 * `palette.js` is the fallback and the same set the default theme's direction
 * is seeded from, so the two cannot disagree about a language both know.
 */
export function directionOf(tag, env = ENV) {
  try {
    const info = new Intl.Locale(tag ?? undefined);
    const text = info.getTextInfo?.() ?? info.textInfo;
    if (text?.direction === 'rtl' || text?.direction === 'ltr') {
      return text.direction;
    }
  } catch {
    // no getTextInfo in this build, or a tag Intl.Locale will not take
  }
  return localeDirection(tag ? { LANG: tag } : env);
}

/**
 * Resolve everything at once. Pure in `env`, so a test can state an
 * environment rather than mutate the process's.
 */
export function resolveLocale(env = ENV) {
  const fromEnv =
    toLanguageTag(env.LC_ALL) ??
    toLanguageTag(env.LC_MESSAGES) ??
    toLanguageTag(env.LANG);

  let resolved = fromEnv;
  let timeZone = null;
  try {
    const options = Intl.DateTimeFormat(
      resolved ?? undefined,
    ).resolvedOptions();
    // ICU may not have the locale the environment named — a small build has
    // one — in which case `resolvedOptions().locale` is the nearest it does
    // have. The environment's answer still stands: it is what the user asked
    // for, and every `Intl` call in the app will fall back the same way this
    // one just did.
    resolved ??= options.locale;
    timeZone = options.timeZone ?? null;
  } catch {
    // no ICU at all
  }

  return Object.freeze({
    locale: resolved ?? 'en-US',
    direction: directionOf(resolved, env),
    weekStartsOn: localeWeekStart(resolved),
    timeZone,
    source: fromEnv ? 'env' : resolved ? 'intl' : null,
  });
}

/** Read once: see the note at the top about why there is nothing to watch. */
let snapshot = null;

/** The resolved locale, as one frozen object. Stable for the process. */
export function systemLocale() {
  snapshot ??= resolveLocale();
  return snapshot;
}

/**
 * Test seam: state a locale without re-execing the process. `null` releases
 * the pin and resolves from the environment again.
 *
 * Naming a `locale` re-derives `direction` and `weekStartsOn` from it rather
 * than keeping the process's own — pinning `he-IL` and silently staying
 * left-to-right is not a locale anybody has.
 */
export function setLocaleForTests(values) {
  if (values === null) {
    snapshot = null;
    return null;
  }
  const current = systemLocale();
  const locale = values.locale ?? current.locale;
  snapshot = Object.freeze({
    locale,
    direction: values.direction ?? directionOf(locale),
    weekStartsOn: values.weekStartsOn ?? localeWeekStart(locale),
    timeZone: values.timeZone ?? current.timeZone,
    source: 'test',
  });
  return snapshot;
}

// A preferences window — the app a control gallery wants to be.
//
//   npm run examples:settings
//   LANG=ar_EG.UTF-8 npm run examples:settings     # the whole window mirrors
//
// A gallery has no reason to exist: a grid of every widget teaches what they
// look like and nothing about using them. A settings window is a real program
// whose content happens to be every control, and it forces the parts a
// gallery never shows — search across pages, a value that can be invalid,
// something to do when you leave with unsaved changes, a reset that has to
// know what the default was, and keyboard-only operation throughout.
//
// ## What to try
//
//   Search            type in the box above the sidebar. It matches settings,
//                     not pages, and jumps to the one you meant — which is
//                     why every setting carries its own keywords.
//   Appearance        "follow the desktop" is the default and the honest one:
//                     `useSystemAppearance()` already knows, and the two
//                     overrides exist for people whose desktop is wrong about
//                     them. Change your desktop theme while it runs.
//   Language          picking Arabic or Hebrew mirrors the entire window —
//                     sidebar to the right, labels right-aligned, the reset
//                     buttons swapping ends. Nothing here is written twice:
//                     `direction` on the theme and logical `paddingStart` do
//                     it (docs/styling.md).
//   Reset             a changed row grows a Reset. The bar at the bottom only
//                     appears when something is dirty, and closing with it
//                     showing asks first.
//
// ## Accessibility is the point of this one
//
// A preferences window is the app people drive with a screen reader, so this
// is where the roles and the announcements have to be right rather than
// present. Every control has a name that is not its neighbouring label by
// accident, the search says how many settings it found, and applying says so
// out loud — `announce()`, which is the explicit form of a live region.
//
//   npm run a11y:probe     # what a screen reader would be told, no desktop
//
// ## What is deliberately not here
//
// **Strings.** Switching the language mirrors the window and moves the date,
// time and number formats — which is `Intl`, built into node — but the labels
// stay English. Translating them wants i18next and a catalogue per language,
// which `docs/ecosystem/i18n.md` covers and which is a dependency this file
// does not have. The mirroring is the part that is react-x11's; the strings
// are the part that is everybody's.
//
// **CJK.** No input method yet (#272), so the language list stops at scripts
// you can type with a keyboard layout.
//
// **Visual-order caret keys.** Left and Right step through the string rather
// than across the screen, in either direction — see `docs/styling.md`. The
// fields themselves mirror (#341): pick Arabic and the search box at the top
// of the sidebar draws its placeholder, its value and its caret from the
// right, like everything around it.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  Button,
  Checkbox,
  Dialog,
  ProgressBar,
  Radio,
  RadioGroup,
  Select,
  Slider,
  Switch,
  ThemeProvider,
  Tooltip,
  announce,
  createRoot,
  createStyles,
  useDesktopSettings,
  useIdle,
  useKeyboardState,
  useLocale,
  useSystemAppearance,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// The settings themselves
//
// One table, because everything else reads from it: the pages, the search,
// the defaults a Reset restores, and the file on disk. A settings window
// whose search knows a different list from its pages is the bug this shape
// exists to prevent.
// ---------------------------------------------------------------------------

const LANGUAGES = [
  { value: 'en-GB', label: 'English (UK)' },
  { value: 'de-DE', label: 'Deutsch' },
  { value: 'fr-FR', label: 'Français' },
  { value: 'ru-RU', label: 'Русский' },
  { value: 'el-GR', label: 'Ελληνικά' },
  { value: 'ar-EG', label: 'العربية' },
  { value: 'he-IL', label: 'עברית' },
];

/** Which of those read right-to-left. `Intl.Locale` knows, where it exists. */
function directionOf(tag) {
  try {
    const info =
      new Intl.Locale(tag).getTextInfo?.() ?? new Intl.Locale(tag).textInfo;
    if (info?.direction) return info.direction;
  } catch {
    // an old ICU, or a tag it does not know
  }
  return /^(ar|he|fa|ur)\b/.test(tag) ? 'rtl' : 'ltr';
}

const SETTINGS = [
  {
    id: 'appearance',
    page: 'Appearance',
    label: 'Theme',
    keywords: 'dark light colour scheme night',
    kind: 'radio',
    options: [
      ['system', 'Follow the desktop'],
      ['light', 'Always light'],
      ['dark', 'Always dark'],
    ],
    fallback: 'system',
  },
  {
    id: 'density',
    page: 'Appearance',
    label: 'Spacing',
    keywords: 'density compact comfortable padding',
    kind: 'select',
    options: ['comfortable', 'cosy', 'compact'],
    fallback: 'comfortable',
  },
  {
    id: 'animate',
    page: 'Appearance',
    label: 'Animate transitions',
    keywords: 'motion animation reduced',
    kind: 'switch',
    fallback: true,
  },
  {
    id: 'language',
    page: 'Language',
    label: 'Language',
    keywords: 'locale translation region rtl arabic hebrew',
    kind: 'select',
    options: LANGUAGES,
    fallback: null, // the desktop's, until someone says otherwise
  },
  {
    id: 'clock',
    page: 'Language',
    label: '24-hour clock',
    keywords: 'time format am pm',
    kind: 'switch',
    fallback: true,
  },
  {
    id: 'name',
    page: 'Account',
    label: 'Display name',
    keywords: 'user name profile',
    kind: 'text',
    fallback: '',
    placeholder: 'what other people see',
    validate: (v) => (v.length > 32 ? 'no longer than 32 characters' : null),
  },
  {
    id: 'email',
    page: 'Account',
    label: 'Email',
    keywords: 'address mail contact',
    kind: 'text',
    fallback: '',
    placeholder: 'you@example.org',
    validate: (v) =>
      v && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)
        ? 'that is not an address'
        : null,
  },
  {
    id: 'idleLock',
    page: 'Privacy',
    label: 'Lock when idle',
    keywords: 'screen lock away security timeout',
    kind: 'switch',
    fallback: false,
  },
  {
    id: 'idleAfter',
    page: 'Privacy',
    label: 'Idle after',
    keywords: 'minutes timeout screensaver',
    kind: 'slider',
    min: 1,
    max: 30,
    step: 1,
    unit: 'min',
    fallback: 5,
    enabledBy: 'idleLock',
  },
  {
    id: 'telemetry',
    page: 'Privacy',
    label: 'Send usage statistics',
    keywords: 'telemetry analytics tracking',
    kind: 'checkbox',
    fallback: false,
  },
];

const PAGES = [...new Set(SETTINGS.map((s) => s.page))];
const defaults = () =>
  Object.fromEntries(SETTINGS.map((s) => [s.id, s.fallback]));

// ---------------------------------------------------------------------------
// The seam: where the settings live
// ---------------------------------------------------------------------------

const FILE = join(homedir(), '.config', 'react-x11-settings', 'settings.json');

export function fileStore(path = FILE) {
  return {
    async load() {
      try {
        return JSON.parse(await readFile(path, 'utf8'));
      } catch {
        // no file, bad JSON, unreadable — all mean "nothing saved yet", which
        // is a first run rather than a failure
        return {};
      }
    },
    async save(values) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(values, null, 2)}\n`);
    },
  };
}

/** For tests, and for `--no-save`. */
export function memoryStore(initial = {}) {
  let held = { ...initial };
  return {
    saved: [],
    async load() {
      return held;
    },
    async save(values) {
      held = { ...values };
      this.saved.push(held);
    },
  };
}

// ---------------------------------------------------------------------------

const s = createStyles({
  root: { flexGrow: 1, flexDirection: 'row', backgroundColor: '$background' },

  sidebar: {
    width: 190,
    paddingTop: 10,
    paddingBottom: 10,
    paddingStart: 10,
    paddingEnd: 10,
    gap: 4,
    backgroundColor: '$surfaceHover',
    borderEndWidth: '$borderWidth',
    borderColor: '$border',
  },
  search: {
    paddingStart: 8,
    paddingEnd: 8,
    paddingTop: '$paddingY',
    paddingBottom: '$paddingY',
    borderWidth: '$borderWidth',
    borderColor: '$border',
    borderRadius: '$radius',
    ':focus': { borderColor: '$accent' },
  },
  found: { fontSize: 10, color: '$textMuted', paddingStart: 4 },
  page: {
    paddingStart: 10,
    paddingEnd: 10,
    paddingTop: 6,
    paddingBottom: 6,
    borderRadius: '$radius',
    ':hover': { backgroundColor: '$surfaceActive' },
    ':active': { backgroundColor: '$surfaceActive' },
  },
  pageOn: {
    backgroundColor: '$accent',
    ':hover': { backgroundColor: '$accentHover' },
    ':active': { backgroundColor: '$accentActive' },
  },
  pageName: { fontSize: 13, color: '$text' },
  onAccent: { color: '$accentText' },

  main: { flexGrow: 1 },
  body: {
    flexGrow: 1,
    overflow: 'scroll',
    paddingStart: 20,
    paddingEnd: 20,
    paddingTop: 16,
    paddingBottom: 16,
    gap: 16,
  },
  heading: { fontSize: 18, color: '$text' },

  // The row is the whole of the layout language here: a label that can wrap,
  // a control that does not, and a Reset that only exists when it is needed.
  // `:focus-within` (#270) is what lights the row the keyboard is in, which a
  // control cannot do for itself — the ring is on the control, the tint is on
  // the row around it.
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingStart: 10,
    paddingEnd: 10,
    paddingTop: 8,
    paddingBottom: 8,
    borderRadius: '$radius',
    ':focus-within': { backgroundColor: '$surfaceHover' },
  },
  rowText: { flexGrow: 1, gap: 2 },
  rowLabel: { fontSize: 13 },
  rowHint: { fontSize: 11, color: '$textMuted' },
  rowInvalid: { fontSize: 11, color: '$danger' },
  control: { width: 230, alignItems: 'flex-start' },
  field: {
    paddingStart: 8,
    paddingEnd: 8,
    paddingTop: '$paddingY',
    paddingBottom: '$paddingY',
    borderWidth: '$borderWidth',
    borderColor: '$border',
    borderRadius: '$radius',
    ':focus': { borderColor: '$accent' },
  },
  fieldBad: { borderColor: '$danger' },

  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingStart: 16,
    paddingEnd: 16,
    paddingTop: 10,
    paddingBottom: 10,
    borderTopWidth: '$borderWidth',
    borderColor: '$border',
    backgroundColor: '$surfaceHover',
  },
  barText: { flexGrow: 1, fontSize: 12, color: '$textMuted' },
  aside: { fontSize: 11, color: '$textMuted' },
});

const DENSITY = { comfortable: 8, cosy: 4, compact: 1 };

// ---------------------------------------------------------------------------

function SettingRow({ def, value, onChange, onReset, dirty, disabled }) {
  const invalid = def.validate?.(value ?? '') ?? null;
  // The control's own name. A `<text>` beside a `Switch` is a sibling, not a
  // label — nothing associates the two, so a screen reader reaching the
  // switch would find it nameless.
  const named = { 'aria-label': def.label, disabled };

  let control;
  switch (def.kind) {
    case 'switch':
      control = (
        <Switch
          {...named}
          checked={Boolean(value)}
          onChange={(ev) => onChange(ev.value)}
        />
      );
      break;
    case 'checkbox':
      control = (
        <Checkbox
          {...named}
          checked={Boolean(value)}
          onChange={(ev) => onChange(ev.value)}
        />
      );
      break;
    case 'select':
      control = (
        <Select
          {...named}
          options={def.options}
          value={value ?? def.options[0]?.value ?? def.options[0]}
          onChange={(ev) => onChange(ev.value)}
          style={{ width: 200 }}
        />
      );
      break;
    case 'radio':
      control = (
        <RadioGroup
          {...named}
          value={value}
          onChange={(ev) => onChange(ev.value)}
        >
          {def.options.map(([id, label]) => (
            <Radio key={id} value={id}>
              {label}
            </Radio>
          ))}
        </RadioGroup>
      );
      break;
    case 'slider':
      control = (
        <box style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Slider
            {...named}
            value={Number(value)}
            min={def.min}
            max={def.max}
            step={def.step}
            onChange={(ev) => onChange(ev.value)}
            style={{ width: 150 }}
          />
          <text style={s.rowHint}>{`${value} ${def.unit ?? ''}`}</text>
        </box>
      );
      break;
    default:
      control = (
        <textinput
          {...named}
          value={String(value ?? '')}
          placeholder={def.placeholder}
          onChange={(ev) => onChange(ev.value)}
          style={[s.field, invalid && s.fieldBad, { width: 200 }]}
        />
      );
  }

  return (
    <box style={s.row} role="group" aria-label={def.label}>
      <box style={s.rowText}>
        <text style={s.rowLabel}>{def.label}</text>
        {invalid ? (
          <text style={s.rowInvalid}>{invalid}</text>
        ) : disabled ? (
          <text style={s.rowHint}>needs the setting above</text>
        ) : null}
      </box>
      <box style={s.control}>{control}</box>
      {dirty ? (
        <Tooltip label="Back to the default">
          <Button onPress={onReset} aria-label={`Reset ${def.label}`}>
            Reset
          </Button>
        </Tooltip>
      ) : null}
    </box>
  );
}

export function SettingsPanel({ store, onQuit }) {
  const [values, setValues] = useState(defaults);
  const [saved, setSaved] = useState(defaults);
  const [page, setPage] = useState(PAGES[0]);
  const [query, setQuery] = useState('');
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(0);

  const appearance = useSystemAppearance();
  const locale = useLocale();
  const keyboard = useKeyboardState();
  const desktop = useDesktopSettings();
  const idle = useIdle({ after: (Number(values.idleAfter) || 5) * 60_000 });

  useEffect(() => {
    let live = true;
    store.load().then((held) => {
      if (!live) return;
      const merged = { ...defaults(), ...held };
      setValues(merged);
      setSaved(merged);
    });
    return () => {
      live = false;
    };
  }, [store]);

  const dirty = useMemo(
    () => SETTINGS.filter((d) => values[d.id] !== saved[d.id]).map((d) => d.id),
    [values, saved],
  );
  const invalid = useMemo(
    () => SETTINGS.some((d) => d.validate?.(values[d.id] ?? '')),
    [values],
  );

  // Search matches **settings**, not pages, and a hit takes you to the page
  // it lives on. Searching a preferences window for "dark" and being shown a
  // list of page names is the failure this avoids.
  const hits = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return SETTINGS.filter((d) =>
      `${d.label} ${d.keywords} ${d.page}`.toLowerCase().includes(q),
    );
  }, [query]);

  useEffect(() => {
    if (!hits) return;
    announce(
      hits.length === 1 ? '1 setting found' : `${hits.length} settings found`,
    );
    if (hits.length && !hits.some((d) => d.page === page))
      setPage(hits[0].page);
  }, [hits, page]);

  const set = useCallback(
    (id, value) => setValues((prev) => ({ ...prev, [id]: value })),
    [],
  );

  const apply = useCallback(async () => {
    setBusy(1);
    await store.save(values);
    setSaved(values);
    setBusy(0);
    // The explicit form of a live region: a screen reader is told the thing
    // happened, without the focus moving to say so.
    announce('Settings applied');
  }, [store, values]);

  const shown = hits ?? SETTINGS.filter((d) => d.page === page);

  // The language the *window* is in, which is a setting and not the desktop's
  // once somebody has chosen. `direction` on the theme is the whole of the
  // mirroring — no component below reads it.
  const tag = values.language ?? locale.locale;
  const theme = useMemo(
    () => ({
      direction: directionOf(tag),
      dark:
        values.appearance === 'system'
          ? undefined
          : values.appearance === 'dark',
      gutter: DENSITY[values.density] ?? 8,
    }),
    [tag, values.appearance, values.density],
  );

  const now = useMemo(() => new Date('2026-08-17T14:05:00Z'), []);
  const clock = new Intl.DateTimeFormat(tag, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: !values.clock,
  }).format(now);
  const number = new Intl.NumberFormat(tag).format(1234567.89);

  return (
    <ThemeProvider value={theme}>
      <box style={s.root}>
        <box style={s.sidebar}>
          <textinput
            value={query}
            placeholder="Search settings"
            aria-label="Search settings"
            onChange={(ev) => setQuery(ev.value)}
            style={s.search}
          />
          {hits ? (
            <text style={s.found}>
              {hits.length === 1 ? '1 setting' : `${hits.length} settings`}
            </text>
          ) : null}
          <box role="listbox" aria-label="Pages" style={{ gap: 2 }}>
            {PAGES.map((name) => {
              const on = name === page && !hits;
              return (
                <box
                  key={name}
                  style={[s.page, on && s.pageOn]}
                  role="option"
                  aria-label={name}
                  aria-selected={on}
                  focusable
                  onClick={() => {
                    setQuery('');
                    setPage(name);
                  }}
                >
                  <text style={[s.pageName, on && s.onAccent]}>{name}</text>
                </box>
              );
            })}
          </box>
          <box style={{ flexGrow: 1 }} />
          {/* Three things the desktop knows that an app should read rather
              than ask about — docs/system.md. */}
          <text style={s.aside}>
            {`${locale.locale} · ${appearance.colorScheme}${
              keyboard.capsLock ? ' · caps' : ''
            }${idle.idle ? ' · idle' : ''}`}
          </text>
          <text style={s.aside}>
            {desktop.doubleClickMs
              ? `double-click ${desktop.doubleClickMs}ms`
              : 'desktop defaults'}
          </text>
        </box>

        <box style={s.main}>
          <box style={s.body} data-testname="page">
            <text style={s.heading}>{hits ? 'Search results' : page}</text>

            {shown.map((def) => (
              <SettingRow
                key={def.id}
                def={def}
                value={values[def.id]}
                dirty={dirty.includes(def.id)}
                disabled={Boolean(def.enabledBy && !values[def.enabledBy])}
                onChange={(v) => set(def.id, v)}
                onReset={() => set(def.id, def.fallback)}
              />
            ))}

            {!hits && page === 'Language' ? (
              <box style={{ gap: 4, paddingStart: 10 }}>
                <text style={s.rowHint}>{`Clock: ${clock}`}</text>
                <text style={s.rowHint}>{`Numbers: ${number}`}</text>
                <text style={s.rowHint}>
                  Labels stay English — the mirroring is react-x11&apos;s, the
                  strings want an i18n library.
                </text>
              </box>
            ) : null}

            {!hits && page === 'Privacy' && busy ? (
              <ProgressBar aria-label="Saving" />
            ) : null}
          </box>

          {/* Only when there is something to do. A bar that is always there is
              a bar nobody reads. */}
          {dirty.length ? (
            <box style={s.bar} role="toolbar" aria-label="Unsaved changes">
              <text style={s.barText}>
                {invalid
                  ? 'one of these is not valid yet'
                  : `${dirty.length} unsaved change${dirty.length === 1 ? '' : 's'}`}
              </text>
              <Button onPress={() => setValues(saved)}>Discard</Button>
              <Button primary disabled={invalid} onPress={apply}>
                Apply
              </Button>
            </box>
          ) : null}
        </box>

        <Dialog
          open={asking}
          title="Leave without applying?"
          width={340}
          height={160}
          onClose={() => setAsking(false)}
          actions={
            <>
              <Button label="Stay" onPress={() => setAsking(false)} />
              <Button primary label="Discard and close" onPress={onQuit} />
            </>
          }
        >
          <text style={{ fontSize: 12, color: '$text' }}>
            {`${dirty.length} change${dirty.length === 1 ? '' : 's'} would be lost.`}
          </text>
        </Dialog>
      </box>
    </ThemeProvider>
  );
}

export function App({ store }) {
  const chosen = useMemo(() => store ?? fileStore(), [store]);
  const closing = useRef(null);
  return (
    <window
      width={820}
      height={560}
      title="Settings"
      minWidth={620}
      minHeight={420}
      onCloseRequest={() => closing.current?.()}
      style={{ backgroundColor: '$background' }}
    >
      <SettingsPanel store={chosen} onQuit={() => process.exit(0)} />
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN && !import.meta.hot) {
  const root = await createRoot();
  root.render(<App />);
}

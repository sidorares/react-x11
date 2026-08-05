# System appearance

What the desktop looks like — light or dark, the accent colour, contrast, and
whether the user asked for less motion — as four values an app renders from.

```jsx
import { useSystemAppearance } from 'react-x11';

const { colorScheme, accent, contrast, reducedMotion } = useSystemAppearance();
```

For the common case — an app that just wants to follow the desktop — there is
nothing to read at all:

```jsx
<ThemeProvider value={light} dark={{ background: '#1e1e1e', text: '#eceff4' }}>
```

## The four values

|                 |                                                                                |
| --------------- | ------------------------------------------------------------------------------ |
| `colorScheme`   | `'light'`, `'dark'` or `'no-preference'`                                       |
| `accent`        | `'#ed5b00'`, or **null**                                                       |
| `contrast`      | `'normal'` or `'high'`                                                         |
| `reducedMotion` | `true` when the user asked for less animation                                  |
| `source`        | which rung answered — `'portal'`, `'xsettings'`, `'macos'`, `'cache'`, or null |

Two of these are easy to get wrong.

**`'no-preference'` means _use your own default_**, not "use light". It is
what a desktop says when it has no opinion, and an app whose own design is
dark should stay dark there.

**`accent` is null far more often than it is not.** Most portal backends
implement `color-scheme` and nothing else, and XSETTINGS has no accent key at
all. Fall back to your own brand colour rather than to grey — an app that goes
colourless on a desktop that simply did not answer the question looks broken.

```jsx
const { accent } = useSystemAppearance();
<Button style={{ backgroundColor: accent ?? '#2980b9' }} label="Save" />;
```

## The first frame

None of this can be known synchronously — the answer is a D-Bus call away —
and an app that renders light and then switches to dark a moment later has a
visible flash.

So **the answer from last time is on disk**, in
`$XDG_CACHE_HOME/react-x11/appearance.json`, and it is read synchronously
before the first render — 0.1 ms, no D-Bus, no await. None of these values
changes more than a few times in a machine's life, so the remembered answer is
almost always the right one; the ladder revalidates it in the background and
replaces it if it moved. Stale-while-revalidate, where the stale value is
nearly always the fresh one.

`source` is how you tell them apart:

```
run 1   {colorScheme: 'no-preference', accent: null,      source: null}      ← nothing remembered
        {colorScheme: 'dark',          accent: '#ed5b00', source: 'portal'}  ← 78 ms later

run 2   {colorScheme: 'dark',          accent: '#ed5b00', source: 'cache'}   ← 0.1 ms, first render
        {colorScheme: 'dark',          accent: '#ed5b00', source: 'portal'}  ← revalidated
```

Revalidation costs one re-render even when nothing moved, because `source`
itself changed. That is deliberate: a `source` that stayed `'cache'` after the
desktop had actually answered would be worth less than the render it saved.

That leaves the very first launch on a machine, where there is nothing to
remember. An app that must be exact rather than probably right waits:

```jsx
import { createRoot, systemAppearance } from 'react-x11';

const [root] = await Promise.all([createRoot(), systemAppearance()]);
root.render(<App />); // useSystemAppearance() is already correct
```

`systemAppearance()` is the imperative twin of the hook, and never rejects.

**Why it is not simply part of `createRoot()`.** Measured cold on a GNOME
session: `createRoot()` alone 85 ms, `createRoot()` with a concurrent portal
probe 124 ms. `dbus-native`'s import is CPU-bound, so it does not hide behind
ntk's startup — and an app that never asks what colour the desktop is should
not pay 40 ms to find out.

`REACT_X11_NO_APPEARANCE_CACHE=1` turns the file off for a process that must
not touch the disk.

## Following the desktop

`<ThemeProvider>` does the whole thing, and giving it a `dark` palette is what
opts an app in. With no `dark` palette nothing is probed and no D-Bus
connection is opened, so every existing app is unaffected.

```jsx
const light = { background: 'white', text: '#2d3436', radius: 8 };
const dark = { background: '#1e1e1e', text: '#eceff4', border: '#3b4048' };

<ThemeProvider value={light} dark={dark}>
  <App />
</ThemeProvider>;
```

`dark` **layers over `value`**, so it names only what changes — `radius: 8`
above is written once and applies to both.

`colorScheme` pins the choice where the app owns it rather than the desktop,
which is what a preference in the app's own settings wants:

```jsx
<ThemeProvider value={light} dark={dark} colorScheme={settings.theme}>
```

`'system'` (the default) follows the desktop; `'light'` and `'dark'` do not.

The desktop's **accent colour is deliberately not adopted on its own** — an
app that asked for dark mode did not ask for its buttons to change colour.
Take it where you want it:

```jsx
const { accent } = useSystemAppearance();
<ThemeProvider value={{ ...light, accent: accent ?? light.accent }} dark={dark}>
```

## Reduced motion

`reducedMotion` is reported, not applied. Nothing in the renderer switches
animation off behind your back — an app with `transition: 150` keeps it until
the app decides otherwise:

```jsx
const { reducedMotion } = useSystemAppearance();
<box style={{ transition: reducedMotion ? 0 : 150, backgroundColor: fill }} />;
```

`transition: 0` is already how "no animation" is spelled, so there is nothing
new to learn. See [styling](styling.md) for what a transition covers.

## The ladder

There is no cross-toolkit palette protocol. Nothing on a Linux desktop lets
one toolkit ask another what colour a window background is; what exists is a
shared theme _name_, and exactly four standardised appearance _values_. Those
four are what this reads, from the best source the machine has:

1. **`org.freedesktop.portal.Settings`** — the real contract, and the only
   source with an accent colour. `ReadAll(['org.freedesktop.appearance'])`,
   live over `SettingChanged`. libadwaita, Qt 6.5+, Firefox and Electron all
   read this one.
2. **XSETTINGS** — pre-D-Bus, X11-only. `Net/ThemeName` is a _name_, so "is
   this dark" comes down to trusting the `-dark` suffix — which is exactly
   what the portal was invented to replace, so it is a fallback and never a
   correction. Live over `PropertyNotify`.
3. **macOS** — `NSUserDefaults` and `NSWorkspace` through one long-lived
   `osascript` child. It is the _only_ source on a Mac: a stock XQuartz has no
   portal, no XSETTINGS manager, and an unset `RESOURCE_MANAGER`.

`RESOURCE_MANAGER` is not a rung. It is where `Xft.dpi`, `Xft.rgba` and
`Xcursor.*` live — font and cursor rendering — and there has never been an X
resource for colour scheme, accent or contrast.

**The first rung that answers owns all four values.** The rungs disagree:
measured on one GNOME session, at one moment, the portal reported
`reduced-motion: 0` while GNOME's own `enable-animations` was `false`. Taking
the best-answered field from each would describe a desktop that does not
exist.

Nothing here holds the process open. The `SettingChanged` subscription leaves
the match rule on the shared connection and releases its reference, so the
socket goes back to `unref()`d: an app whose windows have closed still exits,
and an app with a window on screen is awake anyway and gets the signal. The
macOS child is spawned `unref()`d and killed on exit.

## What each rung can actually answer

|                 | portal                               | XSETTINGS           | macOS |
| --------------- | ------------------------------------ | ------------------- | ----- |
| `colorScheme`   | yes                                  | from the theme name | yes   |
| `accent`        | yes, where the backend implements it | **no such key**     | yes   |
| `contrast`      | yes                                  | from the theme name | yes   |
| `reducedMotion` | version 2 of the interface           | rarely — see below  | yes   |

`Gtk/EnableAnimations` is in GTK's key list but a settings daemon need not
export it, and gnome-settings-daemon does not — 53 settings on the session
this was written against, and it is not among them. So on GNOME the XSETTINGS
rung reports no reduced motion rather than inventing an answer.

## Notes on the sources

**1 is dark and 2 is light** in the portal's `color-scheme`. The ordering
reads backwards, and getting it wrong inverts the appearance of every desktop
that expressed a preference — which is precisely the set of machines that
care.

**The accent colour is a `(ddd)` of sRGB floats in [0, 1]**, and "unset" is
spelled as values outside that range. It is converted to a `'#rrggbb'` string
here, because every style in this renderer takes a CSS colour and
`rgb(0.93, 0.36, 0)` is black.

**The subscription goes on before the read.** A change landing between the
read and the match rule is lost and nothing corrects it — the app stays stale
for its whole lifetime. It is the same shape as the portal `Request` race in
[the file dialog](filedialog.md).

**On macOS the frameworks are read, not `defaults`.** Three of the four
plausible `defaults` keys — `AppleHighlightColor`, `AppleAccentColor`,
`com.apple.universalaccess increaseContrast` — do not exist until the user
changes that setting, so "key not found" is the normal answer rather than the
error case, and `AppleAccentColor` is an index into a table that has to be
maintained by hand. `NSColor.controlAccentColor` is the colour itself, with
Multicolor already resolved, and `NSWorkspace` answers the two accessibility
flags directly.

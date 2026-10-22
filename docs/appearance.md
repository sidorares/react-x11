# System appearance

What the desktop looks like — light or dark, the accent colour, contrast, and
whether the user asked for less motion — as four values an app renders from.

```jsx
import { useSystemAppearance } from 'react-x11';

const { colorScheme, accent, contrast, reducedMotion } = useSystemAppearance();
```

**Most apps never need it.** react-x11's built-in palette already follows the
desktop, so an app that says nothing about colour is dark on a dark desktop
and light on a light one, and its buttons, tabs and menu highlights are the
desktop's accent where the desktop has one — see
[following the desktop](#following-the-desktop) below. Reach for the hook when
you want the values themselves: reduced motion, the accent as a colour for
something that is not a widget, or a design decision that is not a palette.

## The four values

|                 |                                                                                                |
| --------------- | ---------------------------------------------------------------------------------------------- |
| `colorScheme`   | `'light'`, `'dark'` or `'no-preference'`                                                       |
| `accent`        | `'#ed5b00'`, or **null**                                                                       |
| `accentText`    | the ink the desktop writes on its accent — `'#ffffff'` on macOS — or **null**                  |
| `selection`     | the fill under a selected menu or list row — a darker cut of the accent on macOS — or **null** |
| `palette`       | the desktop's whole palette as tokens, on macOS — or **null**                                  |
| `contrast`      | `'normal'` or `'high'`                                                                         |
| `reducedMotion` | `true` when the user asked for less animation                                                  |
| `source`        | which rung answered — `'portal'`, `'xsettings'`, `'macos'`, `'windows'`, `'cache'`, or null    |

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
<box style={{ borderColor: accent ?? '#2980b9' }} />;
```

`accentText` is the ink the desktop puts on that fill. Only macOS names one —
white, on every accent it offers, as its native controls draw it. Elsewhere
it is null, and the palette picks the legible ink by contrast, as it does for
any theme that names a fill and stops there.

`selection` is the fill under a selected menu or list row, which macOS draws
not in the accent but in a darker cut of it (`selectedContentBackgroundColor`).
The built-in palette uses it as `hoverBackground`; a menu lit in the raw
accent beside a native one reads as too bright.

## The desktop's palette

On macOS the rung also reads the semantic colours AppKit paints its own
windows and controls with, in the appearance the desktop is in. They arrive
as `palette`, already in react-x11's vocabulary, and the built-in palette
merges them over the scheme's own the way a `<ThemeProvider>` value merges —
so an app that says nothing about colour comes up in the desktop's greys,
inks and status colours, and follows every retune macOS ships.

The tokens it sets: `background`, `surface`, `surfaceHover`, `text`,
`textMuted`, `border`, `focusRing`, `borderFocus`, `track`, `accent`,
`accentText`, `accentHover`, `accentActive`, `hoverBackground`, `hoverText`,
`selection`, `caret`, `link`, `danger`, `dangerHover`, `success`, `warning`
and `info`. The accent family follows the user's **Accent colour**;
`selection` and `caret` follow the **Highlight colour**, a separate setting;
`link` is never the accent, and `warning` is orange, since yellow fails as
letters. Every token is an opaque colour, flattened over the window ground,
and the status inks and pressed steps it does not name come from
`resolveTheme`, as for any theme. Desktop tinting — the little of the wallpaper in a dark window — is
not in any colour AppKit hands out, so it is not reproduced.

The portal names none of this, so on Linux the built-in palette stands and
only the accent is taken.

## The first frame

None of this can be known synchronously — the answer is a D-Bus call away —
and an app that renders light and then switches to dark a moment later has a
visible flash.

So **the answer from last time is on disk**, in
`$XDG_CACHE_HOME/react-x11/appearance.json`, and it is read synchronously
before the first render — 0.1 ms, no await. These values change a few times
in a machine's life, so the remembered answer is almost always the right
one; the ladder revalidates it in the background and replaces it if it
moved.

`source` is how you tell them apart:

```
run 1   {colorScheme: 'no-preference', accent: null,      source: null}      ← nothing remembered
        {colorScheme: 'dark',          accent: '#ed5b00', source: 'portal'}  ← 78 ms later

run 2   {colorScheme: 'dark',          accent: '#ed5b00', source: 'cache'}   ← 0.1 ms, first render
        {colorScheme: 'dark',          accent: '#ed5b00', source: 'portal'}  ← revalidated

(`accentText`, `selection`, `contrast` and `reducedMotion` travel with them.)
```

Revalidation costs one re-render even when nothing moved, because `source`
itself changed.

That leaves the very first launch on a machine, where there is nothing to
remember. An app that must be exact rather than probably right waits:

```jsx
import { createRoot, systemAppearance } from 'react-x11';

const [root] = await Promise.all([createRoot(), systemAppearance()]);
root.render(<App />); // useSystemAppearance() is already correct
```

`systemAppearance()` is the imperative twin of the hook, and never rejects.
It is not part of `createRoot()` because the probe adds about 40 ms to a cold
start, which an app that never asks what colour the desktop is should not
pay.

`REACT_X11_NO_APPEARANCE_CACHE=1` turns the file off for a process that must
not touch the disk.

## Following the desktop

**Nothing.** That is the whole section.

react-x11's built-in palette _is_ the desktop's: an app that says nothing
about colour is dark on a dark desktop and light on a light one, the way a
GTK or Qt app is, and where the desktop reports an accent — macOS always,
GNOME 47+ and KDE through the portal — `$accent` and the family around it
(`accentHover`, the pressed step, `hoverBackground`, the focus ring) are that
colour, and `hoverBackground` is the desktop's own selection shade where it
names one. On macOS the whole palette is the desktop's — see
[the desktop's palette](#the-desktops-palette). The window background, the widgets and every `$token` in a style all
come from it.

```jsx
// this app follows the desktop
function App() {
  return (
    <window width={400} height={200}>
      <box style={{ flexGrow: 1, padding: 16, backgroundColor: '$background' }}>
        <text style={{ color: '$text' }}>Hello</text>
        <Button primary label="Save" />
      </box>
    </window>
  );
}
```

A `<window>` with no `backgroundColor` takes the palette's, so even that line
is optional.

### Overriding

`<ThemeProvider value={…}>` layers your palette **over the scheme in force**,
so it names what your app changes and everything else keeps following:

```jsx
<ThemeProvider value={{ accent: '#e17055', radius: 10 }}>
```

That app has its own accent and corner radius on both a light and a dark
desktop, and never wrote a second palette.

`colorScheme` pins a subtree, for a design that only works one way or a
preference the app owns rather than the desktop:

```jsx
<ThemeProvider value={brand} colorScheme="light">          // never follows
<ThemeProvider value={brand} colorScheme={settings.theme}> // the app decides
```

**Pinning is also the complete opt-out.** A pinned provider subscribes to
nothing and the widgets under it read the palette it published, so an app that
says `colorScheme="light"` once at the top never has react-x11 ask the desktop
anything.

`dark` is the other half — a palette layered on only when the scheme in force
is dark, for a design whose two schemes are not one recolour of the other:

```jsx
<ThemeProvider value={{ background: '#fffdf7' }} dark={{ background: '#141210' }}>
```

**The accent is followed on the same terms as the scheme**: on a desktop
that has an accent, every control beside the app is already that colour — on
the Cocoa backend the app's own native checkboxes and default buttons are
drawn by AppKit in it. A following provider's `value` wins over the desktop
token for token, so a brand keeps its own colour by naming the family rather
than the one colour:

```jsx
<ThemeProvider value={{ accent: '#e17055', accentHover: '#c0563a', hoverBackground: '#e17055' }}>
```

And a pinned `colorScheme` follows nothing, the accent included. What does
**not** move with the accent is `info`: a note is blue everywhere, under a
green accent as under an orange one, and `success`/`warning`/`danger` say what
they say in any accent.

### Resizing

Dragging a window larger exposes area before the app can have drawn it.
react-x11 fills it with the window's own `backgroundColor`, or the
palette's, and keeps that in step when either moves, so a dark window does
not flash a bright rectangle on every drag of the corner. Nothing to do.

### Testing

`react-x11/test` **pins the colour scheme to light**, and that is not a
convenience: with a palette that follows the desktop, an unpinned suite renders
in whatever colours the machine running it happens to be in, so a pixel
assertion would be green on a light desktop and red on a dark one with nothing
in the test to say so.

```js
await renderX11(<App />, { fonts: FONTS }); // light
await renderX11(<App />, { fonts: FONTS, colorScheme: 'dark' }); // dark
await renderX11(<App />, { fonts: FONTS, colorScheme: 'system' }); // the real one
```

`createMockApp()` pins the same way. `'system'` is for a test that is _about_
what the desktop reports.

The other values pin too, from the first render or under a mounted tree —
which is how a component that follows `reducedMotion`, `contrast` or the
accent is tested, change included. A pinned appearance reports
`source: 'test'`.

```js
await renderX11(<App />, { appearance: { reducedMotion: true } });
await setAppearance({ reducedMotion: false }); // re-renders, repaints
```

See [testing](testing.md#the-desktops-appearance) for the rules.

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

There is no cross-toolkit palette protocol: what a desktop exposes is a
shared theme _name_ and four standardised appearance _values_. Those four
are read from the best source the machine has:

1. **`org.freedesktop.portal.Settings`** — the real contract on Linux, and
   the only Linux source with an accent colour; live over `SettingChanged`.
   libadwaita, Qt 6.5+, Firefox and Electron all read this one.
2. **macOS** — only where the _process_ is running on a Mac, on either
   backend; before XSETTINGS, because on a Mac the Mac's own preference is
   the one the user set. A _Linux_ process drawing to an XQuartz display
   never reaches this rung: it cannot read that Mac's settings.
3. **Windows** — answered by the win32 backend itself: light or dark, the
   accent, contrast and reduced motion, live. Before XSETTINGS for the same
   reason as macOS, and only a tree on the win32 backend reaches it.
4. **XSETTINGS** — X11 only. "Is this dark" comes down to a `-dark` suffix
   on `Net/ThemeName`, so it is a fallback and never a correction. Live.

`RESOURCE_MANAGER` is not a rung: there has never been an X resource for
colour scheme, accent or contrast.

**The first rung that answers owns all four values.** The rungs can
disagree, and taking the best-answered field from each would describe a
desktop that does not exist.

Nothing here holds the process open: an app whose windows have closed still
exits.

### Not climbing it at all

```jsx
await createRoot({ desktop: { appearance: false } });
```

For an app that owns its palette, an embedder that follows the desktop its own
way, and a test that needs the same answer on every machine. The ladder does
not run and **the remembered answer is not read either**: `colorScheme` stays
`'no-preference'` with `source: null`, which means use your own default. See
[desktop.md](desktop.md#turning-the-desktop-off) — `desktop: false` turns this
off along with the other two integrations that talk to the session bus.

## What each rung can actually answer

|                 | portal                               | macOS | XSETTINGS           |
| --------------- | ------------------------------------ | ----- | ------------------- |
| `colorScheme`   | yes                                  | yes   | from the theme name |
| `accent`        | yes, where the backend implements it | yes   | **no such key**     |
| `accentText`    | no — the palette picks by contrast   | yes   | no                  |
| `selection`     | no — the accent itself               | yes   | no                  |
| `palette`       | no                                   | yes   | no                  |
| `contrast`      | yes                                  | yes   | from the theme name |
| `reducedMotion` | version 2 of the interface           | yes   | rarely — see below  |

On GNOME the XSETTINGS rung reports no reduced motion:
`Gtk/EnableAnimations` is in GTK's key list, but gnome-settings-daemon does
not export it.

Design notes — how each source is read, and the macOS colour mapping:
[design/appearance.md](../design/appearance.md).

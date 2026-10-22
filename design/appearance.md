# System appearance: design notes

Contributor-only, not shipped and not on the website. These sections were
moved out of [docs/appearance.md](../docs/appearance.md), the reference, and
keep their original headings so code comments that cite them still resolve.

Under a heading that stayed in the reference, the paragraphs here are the
original wording of ones the reference now says more briefly, kept for the
history, mechanics and rationale the shorter version left out.

## The four values

`accentText` is the ink the desktop puts on that fill, and it comes from the
one source that has an opinion: AppKit writes white on every accent a Mac
offers, including the orange and the pink a contrast ratio would put dark
letters on, and every native control does. The portal names a fill and nothing
about what goes on it, so there it is null and the palette picks the legible
ink by contrast, as it does for any theme that names a fill and stops there.

`selection` is the third colour a desktop names, and macOS is again the one
that does: a selected menu row or list row is filled not with the accent but
with `selectedContentBackgroundColor`, a darker cut of it — same hue,
lightness 0.54 → 0.40 in dark and 0.45 in light for the orange, hand-tuned per
accent rather than computed from it. The built-in palette uses it as
`hoverBackground`; a menu lit in the raw accent beside a native one reads as
too bright.

## The desktop's palette

On macOS the rung reads the rest as well: the semantic colours AppKit paints
its own windows and controls with, in the appearance the desktop is in. They
arrive as `palette`, already in react-x11's vocabulary, and the built-in
palette merges them over the scheme's own the way a `<ThemeProvider>` value
merges — so an app that says nothing about colour comes up in the desktop's
greys, inks and status colours, and follows every retune macOS ships.

Two settings drive it, and they are not one colour. **Accent colour** is an
index into a table of eight, each entry hand-tuned per appearance: the fill,
the darker cut under a selected row, the focus ring and the pressed steps are
all separate table entries, not a formula. **Highlight colour** is a free
sRGB triple that only text selection and the caret read. Everything else is
fixed per appearance.

| token                          | AppKit source                                              | how                                                     |
| ------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------- |
| `background`                   | `windowBackgroundColor`                                    | as is: `#ececec` light, `#323232` dark                  |
| `surface`                      | `controlBackgroundColor`                                   | as is: white, `#1e1e1e`                                 |
| `surfaceHover`                 | the second `alternatingContentBackgroundColors`            | composited over `surface`                               |
| `text`, `textMuted`            | `labelColor`, `secondaryLabelColor`                        | black or white at 85% and 50–55%, over the ground       |
| `border`                       | `separatorColor`                                           | 10% ink over the ground                                 |
| `focusRing`, `borderFocus`     | `keyboardFocusIndicatorColor`                              | the 50% ring over the ground                            |
| `track`                        | `unemphasizedSelectedContentBackgroundColor`               | as is                                                   |
| `accent`, `accentText`         | `controlAccentColor`, `alternateSelectedControlTextColor`  | as is; the ink is white for all eight                   |
| `accentHover`, `accentActive`  | the accent with the pressed and deep-pressed effects       | as is — darker in light, lighter in dark                |
| `hoverBackground`, `hoverText` | `selectedContentBackgroundColor`, the same ink             | as is                                                   |
| `selection`                    | `selectedTextBackgroundColor`                              | the Highlight colour; dark is each channel less 116/255 |
| `caret`                        | `textInsertionPointColor`                                  | the accent of the Highlight colour's name               |
| `link`                         | `linkColor`                                                | as is, never the accent                                 |
| `danger`, `dangerHover`        | `systemRedColor`, pressed                                  | as is                                                   |
| `success`, `warning`, `info`   | `systemGreenColor`, `systemOrangeColor`, `systemBlueColor` | orange for warning: yellow fails as letters             |

AppKit's inks are translucent and every token here is a colour, so each is
flattened over the window ground on the way in. The status inks and the
pressed steps a table does not name come from `resolveTheme`, as for any
theme. What this cannot see is desktop tinting: a dark window on macOS is
`#323232` with a little of the wallpaper in it, and the wallpaper is not in
any colour AppKit will hand out.

## The first frame

So **the answer from last time is on disk**, in
`$XDG_CACHE_HOME/react-x11/appearance.json`, and it is read synchronously
before the first render — 0.1 ms, no D-Bus, no await. None of these values
changes more than a few times in a machine's life, so the remembered answer is
almost always the right one; the ladder revalidates it in the background and
replaces it if it moved. Stale-while-revalidate, where the stale value is
nearly always the fresh one.

Revalidation costs one re-render even when nothing moved, because `source`
itself changed. That is deliberate: a `source` that stayed `'cache'` after the
desktop had actually answered would be worth less than the render it saved.

**Why it is not simply part of `createRoot()`.** Measured cold on a GNOME
session: `createRoot()` alone 85 ms, `createRoot()` with a concurrent portal
probe 124 ms. `dbus-native`'s import is CPU-bound, so it does not hide behind
ntk's startup — and an app that never asks what colour the desktop is should
not pay 40 ms to find out.

## Following the desktop

### Overriding

**The accent is followed on the same terms as the scheme.** The reason is
the one that decided the scheme: an app that says nothing is asking to look
like it belongs, and on a desktop that has an accent every control beside it is
already that colour — on the Cocoa backend the app's own native checkboxes and
default buttons are drawn by AppKit in the user's accent, so a `<Tabs>`
indicator that stayed blue next to them looked like a bug. A brand keeps its
own colour by naming it; a following provider's `value` wins over the desktop
token for token, so name the family rather than the one colour:

### Resizing

The colour a window is _painted_ is only half of it. Dragging a window larger
exposes area before the app can possibly have drawn it, and something has to
be in that area meanwhile — so a window that never says what flashes a default
on every drag of the corner, which on a dark palette is a bright rectangle.

There are two copies of that colour, because a window here is double-buffered:
the X **attribute** the server paints exposed area with, and the colour ntk
clears the part of its backing store that a grow adds. react-x11 sets both —
to the window's own `backgroundColor`, or the palette's — and keeps them in
step when either moves. Nothing to do; it is worth knowing only because they
are the pieces of the palette that live outside this renderer.

Needs **ntk >= 6.6.1**, where `setBackgroundPixel` sets the pair together.
Before that the backing store cleared to the screen's white whatever the
window said, so enlarging a dark window flashed a white strip — and it
survived, because a grow inside the pixmap's headroom reallocates nothing and
so nothing damages it.

## The ladder

There is no cross-toolkit palette protocol. Nothing on a Linux desktop lets
one toolkit ask another what colour a window background is; what exists is a
shared theme _name_, and exactly four standardised appearance _values_. Those
four are what this reads, from the best source the machine has:

1. **`org.freedesktop.portal.Settings`** — the real contract, and the only
   source with an accent colour. `ReadAll(['org.freedesktop.appearance'])`,
   live over `SettingChanged`. libadwaita, Qt 6.5+, Firefox and Electron all
   read this one.
2. **macOS** — `NSUserDefaults` and `NSWorkspace` through one long-lived
   `osascript` child, and only where the _process_ is running on a Mac. It
   comes before XSETTINGS on purpose: on a Mac, the Mac's own preference is
   the one the user set, and an XSETTINGS daemon there is something they
   installed by hand. It is in practice the only source on a Mac, on either
   backend — a stock XQuartz has no portal, no XSETTINGS manager and an
   unset `RESOURCE_MANAGER`. A _Linux_ process drawing to an XQuartz display
   never reaches this rung at all, which is correct: it cannot read that
   Mac's defaults.
3. **Windows** — answered by the win32 backend itself: the Personalize key
   for light or dark, DWM for the accent, `SystemParametersInfo` for contrast
   and reduced motion, live over `WM_SETTINGCHANGE` and its siblings. Before
   XSETTINGS for the same reason macOS is, and asked of the app rather than
   of the platform, so only a tree on the win32 backend reaches it.
4. **XSETTINGS** — pre-D-Bus, X11-only. `Net/ThemeName` is a _name_, so "is
   this dark" comes down to trusting the `-dark` suffix — which is exactly
   what the portal was invented to replace, so it is a fallback and never a
   correction. Live over `PropertyNotify`.

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
[the file dialog](../docs/filedialog.md).

**On macOS the frameworks are read, not `defaults`.** Three of the four
plausible `defaults` keys — `AppleHighlightColor`, `AppleAccentColor`,
`com.apple.universalaccess increaseContrast` — do not exist until the user
changes that setting, so "key not found" is the normal answer rather than the
error case, and `AppleAccentColor` is an index into a table that has to be
maintained by hand. `NSColor.controlAccentColor` is the colour itself, with
Multicolor already resolved, `alternateSelectedControlTextColor` is the ink
AppKit writes on it, `selectedContentBackgroundColor` is the shade under a
selected row (both resolved in the appearance the desktop is in, since a
dynamic colour in a bare `osascript` resolves as Aqua otherwise), and
`NSWorkspace` answers the two accessibility flags directly.

**A process reads the colours once.** `controlAccentColor` is resolved on
first use and cached for the life of the process: after the user picks another
accent, the same process still answers the old one, with or without an
`NSApplication`. So the watcher prints its values once and, on the change
notifications, exits — and react-x11 spawns another, whose first read is
fresh. A watcher that re-read in place re-announced the same values, and a
running app never saw the change. The Cocoa backend
reads the same child: it is one source for both backends, and the accent it
reports is the one AppKit draws the native bezels in.

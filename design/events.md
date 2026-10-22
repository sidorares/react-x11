# Events: design notes

Contributor-only, not shipped and not on the website. These sections were
moved out of [docs/events.md](../docs/events.md), the reference, and keep
their original headings so code comments that cite them still resolve.

## Dispatch

### When the response is painted

**Discrete input paints from its own handler**, in the same turn of the
event loop as the press — not on the next frame. A click has exactly one
visual answer (a button darkens, a caret lands, focus moves), so there is
nothing a frame's wait could coalesce it with, and waiting would charge it
up to a frame interval plus a server round trip on top of a paint that
measures in the hundreds of microseconds. The dispatcher therefore lands
React's discrete-priority commit and paints once the whole dispatch has
unwound — the default action, your handlers and React's update all in one
pass, never a half-updated frame followed by a second one.

Discrete means everything ntk does not coalesce: `mouseDown`/`mouseUp`,
`keyDown`/`keyUp`, focus and blur, and the window manager's close request.

**Motion and the wheel stay on the frame clock.** `mouseMove`, and the hover
enter/leave work it drives, are the opposite case — the pointer reports at
device rate and only the newest position matters — so they coalesce to at
most one repaint per frame. A scroll is the same case for a different reason:
a touchpad reports one dozens of times a frame, and nobody can see those
frames apart. What makes the wait free is that ntk coalesces a scroll by
_adding it up_ rather than keeping the newest, so a frame's event carries the
whole distance and the pacing costs a paint, never a pixel.

**Hover follows content.** A scroll moves content under a pointer that did
not move, and so can a layout that reflows it. After a frame that laid out
— every frame of a scroll does — the window asks again what is under the
pointer's last position, as a browser asks at the frame after a scroll:
`:hover`, `onMouseEnter` and `onMouseLeave` change as a motion would change
them, and the node under the pointer hears `defaultMouseMove` at that point,
so an element that paints its own hover (a document, a graph) re-reads what
it is over. `onMouseMove` is not called — the pointer did not move — and
nothing changes while a press or a capture holds the pointer, or after the
pointer has left the window.

**Hover belongs to the active window, on macOS.** Nothing in CSS or the
DOM ties hover to focus — `:hover` is "while the user designates an element
with a pointing device", and a `mousemove` is owed whenever the pointer moves
over an element — but the platform does. A window there that is not the
active one does not track the pointer: AppKit's own controls roll over in
the key window alone, and a browser drops the moves over a window that is
neither key nor main and tells the page the pointer left. So on the Cocoa
backend a window that loses the keyboard hears `onMouseLeave` down its hover
path, `:hover` comes off, an element that paints its own hover hears
`defaultMouseLeave`, and no motion, enter, cursor or attention follows until
the window is the active one again — when the hover comes back at the point
the pointer is at, without waiting for it to move. `<window onMouseOut>` is
not called: the pointer is still over it.

"Active" is the focus's answer, as it is for the caret
([below](../docs/events.md#window-focus)): a window whose `<Dialog>` holds the keyboard still
hovers. A `<popup>` nothing manages — a menu, a dropdown, a popover under a
tray item — always does, since it is on the screen because the user asked
for it, in an application that may have no active window at all. A press
still lands where it was aimed, as the first click on a window always has
here, and its gesture runs on; the wheel scrolls a background window as the
platform has it. On X11, Wayland and Windows nothing changes: every toolkit
there hovers in a window without the keyboard, and with focus-follows-mouse
the question hardly arises.

Bursts of discrete input stay bounded by the same mechanism. While the
server has not acknowledged the last frame, the response goes back to the
paced path: click twice quickly and the first press paints immediately while
the second folds into one catch-up frame. Update instantly, then catch up.

This needs ntk 5.2.0 or newer, which publishes the `frameInFlight()` gate
the decision is made with. On an older ntk everything still works; the
response simply waits for the next frame, as it did before.

## Event object

**A Ctrl chord is read from the keysym, not the code point.** `codepoint`
comes from the _shifted_ keysym, so Ctrl+Shift+Z arrives as `Z` and Ctrl+Z as
`z`; a handler that compares code points misses half of its own shortcut.
`ctrlChordLetter(ev)` from `react-x11/keysyms` answers with the lowercase
keysym either way — it is what `<textinput>` reads Ctrl+C/V/Z with, and it is
exported because any widget with a chord of its own needs the same rule:

```js
onKeyDown={(ev) => {
  if (ev.ctrlKey && ctrlChordLetter(ev) === keysymOf('d')) duplicateLine();
}}
```

### Modifiers

**Mod1 is Alt and Mod4 is Super by convention, not by protocol.** X says
only that there are eight modifier rows and lets the keymap decide which
keys sit in each; those two are where `setxkbmap` puts Alt and Super, and
where every toolkit — GTK and Qt included — reads them from. The setup that
disagrees still has the raw mask: `ev.nativeEvent.buttons` is the state
field as it arrived, and `MOD` in `react-x11/keysyms` names its bits
(`MOD.Mod3`, `MOD.Lock` for Caps Lock, and so on).

### The primary modifier {#primary-modifier}

**On the Cocoa backend the editing chords are ⌘, not Ctrl.** ⌘ arrives as
`metaKey` (the DOM's own macOS mapping), and the app says which of the two its
shortcuts are pressed with: `app.primaryModifier` is `'Super'` there and absent
everywhere else, X11 under XQuartz included. The built-in editors read it, so
`<textinput>`'s Undo, Cut, Copy, Paste and Select All are ⌘Z, ⌘X, ⌘C, ⌘V and
⌘A on a Mac, Redo is ⇧⌘Z, and the right-click menu prints them that way. A ⌃
or ⌘ chord the field has no answer for is never typed as text — AppKit hands
over the key's bare character with either held. A widget with chords of its
own asks the same question with `primaryModifierHeld`:

```js
import { ctrlChordLetter, keysymOf, primaryModifierHeld } from 'react-x11/keysyms';

onKeyDown={(ev) => {
  if (primaryModifierHeld(ev, app) && ctrlChordLetter(ev) === keysymOf('d'))
    duplicateLine();
}}
```

Everywhere else the bindings are GTK's, Qt's and Windows': Ctrl+←/→ and
Ctrl+⌫/⌦ by word, Ctrl+A to select all. The two sets disagree about Ctrl
outright — ⌃← is the start of the line on a Mac, and ⌃A the start of the
paragraph — so a backend has one set or the other, never a mix. Home and
End move the caret to the ends of the line on every backend: AppKit scrolls without moving it, which a field — one
line, its caret the point of the keystroke — has no use for.

⌃K's kill buffer is the application's and not the pasteboard, as it is in
AppKit: a kill leaves what ⌘C copied alone, ⌃Y in one field yanks what ⌃K
killed in another, and kills one after another add up, so the two that take
a line and then its break yank back as the line. A `sensitive` field kills
into nothing, for the reason it offers no Copy.

## Space and Enter are a click {#space-and-enter-are-a-click}

The keys are a **default action**, which is the whole of the contract:

- `preventDefault()` in the node's own `onKeyDown` takes the key back — that
  is how a widget that answers Enter with something other than its click
  (a disclosure opens a branch; the click only moves the selection) keeps it;
- a node with no `onClick` is untouched, whatever its `role` says. A role
  advertises an action to an assistive technology, which has no other way to
  ask; a key press is already at the node, so there is nothing to advertise
  and nothing to activate. `role="button"` with only an `onKeyDown` stays
  yours;
- `<textinput>` and `<textarea>` never activate: their own `defaultKeyDown`
  answers the keystroke, so Space types a space;
- **a scroll pane keeps Space.** Space and Shift+Space page a scrolling `<box>`
  ([elements.md](../docs/elements.md#scrolling)) — that is a default action too, and
  the pane answers it before this one, so a clickable pane pages with Space
  and activates with Enter. A focusable row _inside_ a pane is not affected
  either way: default actions run on the focused node, and the pane is not
  it;
- **a chord is not a press.** With Ctrl, Alt or Super held — ⌘ or ⌃ or ⌥ on
  the Cocoa backend — Space and Enter are a command, and the node leaves them
  to whoever bound it: a menu's Ctrl+Return fires with focus on a clickable
  box exactly as it does anywhere else ([accelerators](../docs/events.md#accelerators)).

Shift is not a command, and it travels: the synthesized click carries the key
press's own modifier mask, so Shift+Enter reaches `onClick` as a shift-click.

It is the same function an assistive technology's activation goes through, on
purpose — one definition of "activate" for the pointer, the keyboard and
Orca, which cannot then disagree about a control
([accessibility.md](../docs/accessibility.md#at-driven-controls)).

## Accelerators {#accelerators}

Ctrl+S calls `save()` without the menu being opened. The same array is what
`aria-keyshortcuts` announces and what crosses the bus when the desktop's
panel draws the menu ([globalmenu.md](../docs/globalmenu.md)) — and it stays bound in
that case, because the panel draws the rows but the key is pressed in your
window and nothing else is going to deliver it. (The macOS menu bar is the
exception, and answers the ⌘ chords it shows by itself —
[below](../docs/events.md#the-macos-menu-bar).)

### The chord

The key is named the way X names it, which is what `gdk_keyval_name()` emits
and what a panel's importer parses: `plus` rather than `+`, `Prior` rather
than `PgUp`, `Return` rather than `Enter`. A one-character name is that
character. `keysymFromName()` in `react-x11/keysyms` is the resolver, and
`matchesShortcut(ev, shortcut, { primary })` the matcher, for an application
dispatching chords its own way.

Four rules, all of which a hand-rolled `onKeyDown` gets subtly differently:

- **exact on the four modifiers.** Ctrl+S does not fire on Ctrl+Shift+S.
- **indifferent to the locks.** Caps Lock and Num Lock are not modifiers here
  — `ctrlKey`/`altKey`/`shiftKey`/`metaKey` are the four named bits and
  nothing else, so a chord keeps working with either light on.
- **the key, not the character.** Matching is against `ev.keysym`, the Latin
  keysym for the physical key, so a chord survives a layout switch
  ([Layouts](../docs/events.md#layouts)) — and `['Control', 's']` and `['Control', 'S']` are
  one binding rather than two. A chord that names a **symbol** also matches
  the character the key produced, because `+` is the shifted `=` and
  `[['Control', 'plus']]` has to be pressable; letters stay out of that path,
  since it is exactly what would make Ctrl+Shift+S fire a Ctrl+S binding.
- **`enabled` and `visible` gate it.** A dimmed item's chord fires nothing,
  and neither does an item inside a submenu whose parent is disabled — a
  command you cannot reach by opening the menu is not one a key should reach.
- **`Control` is the primary modifier**, above — exact on it as on the rest,
  so ⌃⌘S does not fire a ⌘S binding either.

### Who gets the key first

So **a focused text field keeps the chords it answers**: Ctrl+C copies the
selection and never reaches a menu item that also says Ctrl+C. Ctrl+S is not
one of the field's, so it falls through to the menu — a control that swallowed
every chord would be a control no application could put a shortcut behind.

Two things suppress them entirely, both because something else has the
keyboard:

- **an open menu.** It is holding a pointer grab, and a chord firing a second
  command out from under the one being pointed at is a bug nobody reproduces.

**An app with no `<window>` at all** — a menu-bar app, whose whole UI is the
popover a tray click opens — binds against the root-level `<popup>` that took
the keyboard instead
([elements.md](../docs/elements.md#a-popover-under-a-tray-item)). There is nothing
else for a shortcut to belong to, and it is the window the keys are arriving
on. A binding that lands on nothing at all — no window and no popup either —
warns once in development and names `scope`, rather than leaving a chord that
is drawn, announced and dead.

### The macOS menu bar {#the-macos-menu-bar}

On the Cocoa backend a `MenuBar` is drawn by the system
([globalmenu.md](../docs/globalmenu.md)), which installs each item's chord as an
`NSMenu` key equivalent where it can spell one — a single chord on a
character key — and AppKit then runs the item on a ⌘ chord by itself. It does
so _after_ the window has seen the key, whatever the window did with it. So
those chords are **reserved**: the window's accelerators are not offered them
at all, neither the bar's own binding nor a `useAccelerator` on the same
chord, whichever mounted last, and the item runs once. A chord the menu bar
cannot spell — a function key, a second alternative, `plus` — or one with no
`Control` or `Super` in it stays the window's, and fires the way it does
anywhere else.

The reservation cannot reach steps 1 and 3 above, which run before it: an
`onKeyDown` that answers ⌘S for itself, or a focused field answering ⌘C beside
an Edit menu whose Copy says ⌘C, runs alongside the menu item rather than
instead of it — `preventDefault()` there does not reach AppKit. Leave a chord
the menu bar shows to the menu bar.

## The wheel {#wheel}

Where the server has XI2, those pixels are the distance the device actually
measured. The core protocol has no wheel at all: a scroll arrives as a click
of button 4/5/6/7, and a click carries no magnitude, which is why every
scroll used to be exactly one notch. XI2 carries the same gesture as the
device's own _scroll valuators_, so a touchpad's two-finger scroll reports
the fractions of a notch it really was, and `deltaY` is `14.5` rather than
`48` twice a second.

**Nothing is opted into.** A `<window>` selects XI2 the first time it is
scrolled and falls back to the wheel buttons where the server has none, so a
handler written against `deltaY` works on both and the difference is the
value. A `<popup>` is on the buttons deliberately — it holds a pointer grab,
and a core grab delivers core events — so a scroll inside an open menu moves
a notch at a time. Needs ntk >= 7.5.0.

The selection waits for the first wheel because it is not free. An XI2
selection _replaces_ the core one for the same event type, and an `XIMotion`
is around 136 bytes on the wire where a core `MotionNotify` is 32 — measured
against Xorg 21.1. Motion is the one event that keeps arriving at frame rate
for as long as the pointer is over the window, so selecting it up front bills
every window about 8 KB/s of pointer traffic while the pointer crosses it,
including the dialogs, toolbars and forms that never see a wheel at all.

What waiting costs is the opening event of the first gesture in a window's
life, and it costs less than it sounds: a mouse wheel reports whole notches
either way, and ntk treats the first valuator event as a seed with no
distance to report, so under an eager selection that same first event moves
nothing at all.

`<window xi2>` selects at creation anyway, for an app whose whole interaction
is a touchpad and which wants the very first flick smooth. `<window
xi2={false}>` refuses the selection for the window's whole life.

## Composition: dead keys and Compose {#composition}

`é` is not a key. On a French, German or us-intl layout it is `dead_acute`
then `e`, and a dead key is a keysym with **no code point at all** — so a
renderer that types from `ev.codepoint` types the letter and drops the
accent. That is most accented input in Europe, and it is invisible to anyone
testing on a US layout (issue #272).

The dead keys are Unicode's own composition rather than a table somebody
maintains, so `dead_breve` + `и` is `й` and `dead_acute` + `α` is `ά`
without anyone having written those down. What is written down is the part
Unicode has no rule for: `dead_stroke` + `o` is `ø`, and the `Multi_key`
symbol sequences, which are conventions rather than compositions.

### Handling it yourself

**A key an open composition took carries no text of its own.** `ev.key` and
`ev.codepoint` are `undefined` on it and `ev.composing` is true, because its
text arrives on the composition event instead — an application that types
from `onKeyDown` would otherwise insert `o`, `c` and then `©`. The keysym is
still there, so a chord still matches.

The order is **application chords → composition → the element → focus
traversal**: an `onKeyDown` that calls `preventDefault()` keeps its key and
the composer never sees it, and a key the composer does take never reaches
the element's `defaultKeyDown` — so a dead key cannot also fire an
accelerator, and a Compose sequence containing `z` cannot undo halfway
through.

A composition is abandoned, never half-committed, when focus leaves, when the
window loses the keyboard, or when a press puts the caret somewhere else.

A screen reader is told the same story: the preedit is a text run of its
own and its churn is marked as text the user did not type, so the accent is
not read out and the character it commits is —
[accessibility.md](../docs/accessibility.md#while-a-composition-is-open).

### Input methods

On the [Wayland backend](../docs/wayland-backend.md) the compositor's input method
(IBus under GNOME) drives the same three events over `zwp_text_input_v3`,
and on the Windows backend the system IME drives them over IMM32
(`src/win32/ime.js`): its preedit arrives on `onCompositionUpdate` and the
text it commits on `onCompositionEnd`, inserted the way a typed character
is. Two things are only there:

- `ev.cursorBegin` / `ev.cursorEnd` on an update — code-point offsets into
  `data` — when the engine says where inside its preedit the cursor is, or
  which segment of a phrase it is converting (drawn with a heavier
  underline). A dead key never sets them.
- a commit with no preedit before it — an emoji picker, an engine that
  commits directly — is a start and an end in one.

Keys the input method consumes never reach the application, so a dead key
composed by IBus does not also reach the client-side table; a key that does
arrive is one the input method declined. `<textinput sensitive>` offers the
input method none of its text, and `inputMode` on a `<textinput>` tells it
what to expect ([elements.md](../docs/elements.md#textinput)).

The **Cocoa backend has no input method yet** — `NSTextInputClient` is
[macos.md](../docs/macos.md)'s IME work — so its text is what each key event says it
typed. A dead key such as ⌥E types nothing and shows nothing, and the key
after it types what macOS put on that key: `é` where the event carries the
dead key's composition, the bare letter where it does not, never the two
letters reading the key's own character used to type. A key that typed more
than one character — the accent and a letter it does not combine with, `´s`
— commits them as one composition, a start and an end in one, the way an
input method's commit arrives. Press-and-Hold accents and CJK input wait on
the same work.

### Changing the table

`compose: 'system'` is the whole file shorthand, `compose: false` turns
composition off for an app that does its own, and later definitions win over
earlier ones — which is what makes a Compose file an override of the
built-ins rather than an addition beside them. Parsing is X's own format;
`include` directives are ignored, and a line naming keysyms outside ASCII
and the dead-key block (`<Greek_alpha>`, `<Cyrillic_a>`) is skipped rather
than guessed at.

**What this is not is an input method.** There is no preedit arriving from
another process and no candidate list, so CJK still needs XIM or an
IBus/Fcitx client — issue #272 tracks it. The events above are the surface it
will arrive on.

## Layouts {#layouts}

**⌥ types, on the Cocoa backend.** It is the layout's third and fourth level
there rather than a modifier: ⌥S is `ß` on a US keyboard, and on a German one
⌥L is `@` and ⌥5 and ⌥8 are `[` and `{` — the only keys that type them. So
`ev.key` and `ev.codepoint` are what the layout typed, with ⌥, Shift and Caps
Lock applied, while `ev.keysym` is still the key (`s`) and `ev.altKey` is
true: an Alt+S accelerator still matches, and a field types `ß`. A ⌘ or ⌃
chord types nothing and is named by its key, so ⌘⌥S is a chord on S — the
same split the DOM makes on a Mac.
`ev.group` is the active XKB group, 0-3, for an application that wants to
show which layout is live — a switch sends no other notice.

Where the Latin keysym comes from depends on how the layout got there, and
the two mechanisms have nothing in common:

- **Linux/XKB** loads every layout at once as a group and switches which one
  is live; the keymap never changes and **no MappingNotify is sent**. The
  Latin keysym is on the same keycode, in whichever group is the Latin one —
  which under `ru,us` is the second.
- **XQuartz** has no groups. It synthesizes the keymap from the active macOS
  layout and _overwrites_ it when the input menu changes (Preferences →
  Input → "Follow system keyboard layout"; without that, nothing downstream
  can help), then sends MappingNotify. After a switch to Russian **no group
  anywhere holds Latin**, and the only thing left that still means "the Z
  key" is the keycode — so that is what is used, against the US position of
  whichever keycode scheme the server speaks.

`accelerators` also takes a keycode→keysym table (`{ 52: 'z' }`) for a
server whose keycodes are neither evdev's nor macOS's, which is the only
case the two built-in ones do not cover.

One thing the core protocol cannot express is the difference between two
groups of two levels and one group of four, so **the AltGr row is not
reachable**: `ev.keysym` and `ev.codepoint` read groups only. Resolving it
needs XkbGetMap, which node-x11 does not implement.

## Pointer capture

Capture is released automatically on `mouseup` (like the DOM's implicit
pointer capture) and when the capturing node unmounts; `ev.releasePointer()`
ends it early. While captured, hover stays where it was — dragging must not
light up every widget the pointer crosses.

## Focus

`focusable` opts a node into focus (`<textinput>` is focusable by
default, and so is a scroll container with somewhere to scroll), `autoFocus`
takes it at mount, and every drawn node has
`focus()` / `blur()` / `focused` on its ref — plus `focusWithin`, which is
true while focus is on the node **or inside it**, the question a modal asks
before taking focus itself. To _draw_ that rather than read it, there is a
`':focus-within'` style block
([styling.md](../docs/styling.md#inline-pseudo-states)), which is what a row
containing a field wants. `focus()` hands the node back, so a component
can forward it straight out of an imperative handle. Focusing a node inside a
scroll container scrolls it into view — unless a press focused it, since
the node is under the pointer. Mousedown focuses the nearest
focusable ancestor of the hit node; Tab / Shift+Tab cycle through focusable
nodes in tree order. Keyboard
events route to the focused node's ancestor chain. `disabled` opts a node
back out of focus, whatever else it says.

**A focused node shows a ring**, and how focus arrived decides whether it
does. A press sets `:focus`; everything else — Tab, `autoFocus`,
`node.focus()`, a modal handing focus back as it closes — also sets
`:focus-visible`, and that is the state the ring is drawn on. A press on a
**text control** is the one press that sets both, because a field the
keyboard is about to go to has to say so however focus got there. It costs no
layout and needs no opt-in; see
[styling.md](../docs/styling.md#the-focus-ring) for restyling it.

### Focus scopes (modals)

`trapFocus` makes a node own a **focus scope**. While it is the innermost
scope:

- Tab / Shift+Tab only visit focusables inside it — the rest of the window
  is unreachable by keyboard;
- a press outside it does not move focus (poking at the window behind a
  modal is inert as far as focus goes — the press itself still dispatches,
  so pair it with `grab` + `onDismiss` for a real modal);
- when the scope unmounts, focus goes back to whatever had it before the
  scope opened — no bookkeeping in the widget.

That is a modal dialog, with the popup taking focus at mount:

```jsx
function Dialog({ open, x, y, onClose }) {
  if (!open) return null;
  return (
    <popup
      trapFocus
      grab
      x={x}
      y={y}
      width={280}
      height={120}
      onDismiss={onClose}
    >
      <textinput autoFocus />
      <Button label="OK" onPress={onClose} />
    </popup>
  );
}
```

### Focus inside a `<popup>`

An override-redirect window never receives the X input focus, so a popup
cannot hold focus itself: the **owner window** does, and a node inside the
popup can be the focused node of that window. Keys arrive at the owner
window and are dispatched to it, then bubble out through the popup's
position in the JSX tree into the owner's handlers, so nothing has to
proxy them.

### Window focus

Node focus is per `<window>`, and the window itself may or may not be the
one the X server sends keys to — that is the window manager's call.
`<window onFocus>` / `<window onBlur>` report it (ntk ≥ 3.7.0, X
`FocusIn`/`FocusOut`).

While the window is unfocused the focused node **keeps** focus, exactly as
`document.activeElement` survives a window blur in a browser — it just
stops looking active: a `<textinput>` caret stops blinking, and resumes
when the window is focused again. Calling `focus()` on a node in a window
that does not have the input focus asks for it (X `SetInputFocus`), though
a window manager is free to refuse.

Which of an application's windows a key is _delivered_ to is a separate
question again, and not one the application answers: the server sends it to
the window holding the input focus, or to whichever descendant of that
window the pointer happens to be over. A nested `<window>` and a `<popup>`
put the two apart — the field is focused inside them, the keyboard belongs
to the top-level — so a key is dispatched to **the node that has focus**,
whichever of that top-level's windows it arrived at, and bubbles from there
out through the JSX tree. Where more than one window holds a focused node,
the one focused last is where the user is typing and the one that answers.

"Unfocused" is likewise the **focus's** answer rather than any one window's.
A `<popup>` shares its owner's focus, and a managed one — a `<Dialog>` — is a
real window the window manager focuses in its own right, so opening one takes
the X focus off the owner at the moment the field inside the dialog starts
receiving keys. The caret follows the window that actually holds the
keyboard, whichever of the ones sharing that focus it is; asking the owner
alone is how a focused field ends up with a `:focus` ring and no caret. By
the same token, `focus()` on a node inside an open dialog does not ask the
server for the input focus — the dialog already has it.

### Focus and visibility

**Focus follows visibility.** A subtree that goes off the screen gives up
the keyboard: a `<Suspense>` boundary showing its fallback, an `<Activity
mode="hidden">`, a `display: 'none'`, a `<popup>` being unmapped. The
focused node fires `onBlur`, `:focus`/`:focus-within` come off, and keys go
to the window instead — because a control nobody can see must not be
collecting keystrokes, and the application's state must not advance from
them. Tab skips invisible nodes for the same reason.

**And it comes back with it.** When the subtree is revealed, focus returns
to where it was, ring and all, so a boundary that re-suspended mid-edit
leaves the user typing where they were. Two rules keep that from being
focus stealing:

- it only happens when **nothing else has the keyboard** — anything focused
  while the subtree was away keeps focus;
- it is a restore rather than a navigation: no scrolling into view, and no
  X `SetInputFocus`, so a background window revealing something never takes
  the keyboard off another application.

`createRoot({ restoreFocusOnReveal: false })` turns the second half off, for
an app that wants the browser's answer — focus that fell to nothing stays
there, and coming back is the user's own Tab. The release is not optional.

## Cursors

The `cursor` style property (`'pointer'`, `'text'`, `'wait'`, `'move'`,
`'crosshair'`, `'ew-resize'`, `'ns-resize'`, `'grab'`, `'not-allowed'`, …)
applies the deepest hovered node's cursor to the window, via ntk's cursor
cache over the standard X cursor font.

`cursor: 'none'` hides the pointer (ntk ≥ 4.2.0) — the kiosk case. It is
the one name that is not a glyph in that font, so ntk builds it from an
empty 1×1 mask. Note it is **not** the same as setting no cursor at all:
with none of a node's ancestors naming one, the window inherits the root
window's cursor and the pointer stays visible.

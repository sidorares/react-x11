# The global menu: design notes

Contributor-only, not shipped and not on the website. These sections were
moved out of [docs/globalmenu.md](../docs/globalmenu.md), the reference, and keep
their original headings so code comments that cite them still resolve.

The rest of this page is about the middle row, which is the one with a
protocol in it. The macOS row is
[macos.md §Menus](../docs/macos.md#menus-the-global-menu-finally-at-home): the
adapter is `src/cocoa/globalmenu.js`, it consumes the same `menus` array
through the same snapshot machinery, and because a menu bar is a platform
constant rather than a service that may or may not be running, it takes the
menu the moment it is installed — the drawn fallback never renders there.

## The item vocabulary is the protocol's

### Shortcuts are a list, not a string

**On macOS, `Control` means ⌘.** A cross-platform app writes its shortcuts
in the primary modifier, and the Mac's primary modifier is Command, not its
own ⌃ — so `[['Control', 'S']]` becomes ⌘S in the menu bar, which is what a
Mac user expects Save to be. `Super` maps there too; `Shift` and `Alt` are
themselves. A chord the `NSMenu` spelling cannot express is simply not
printed beside the item — the binding still fires, because the app's own
window answers it (below). The text controls' own chords follow the same rule
there, and so does the edit menu that prints them
([events.md](../docs/events.md#primary-modifier)), and so do the window's own
bindings: `useAccelerator`, and a drawn `MenuBar` or `ContextMenu`, which
prints `⌘S` beside the row ([events.md](../docs/events.md#the-chord)).

That matters most in exactly this case. When the panel draws the menu, the
**panel is not going to deliver the key** — it has no idea the window's
keyboard is where the user is — so the app's own window still has to, and
`MenuBar` keeps its bindings when it stops drawing. `accelerators={false}`
turns them off for an application with a dispatcher of its own.

## What happens on the wire

The D-Bus path, in enough detail to recognise it in `dbus-monitor` and to
know what to look at when a menu does not appear. None of this applies on
the Cocoa backend, where there is no wire and no registrar — installing an
`NSMenu` is the whole of it.

1. **Detection.** Does something own `com.canonical.AppMenu.Registrar` right
   now? Only ownership counts — see the trap below.
2. **Export.** The menu is served at `/com/react_x11/menus/<xid>` on the
   process's existing bus connection ([dbus.md](../docs/dbus.md)), so the desktop sees
   one application rather than several.
3. **Registration.** `RegisterWindow(xid, path)`. The service name is inferred
   from the sender, so only the path is supplied.
4. **The KDE properties**, in addition: `_KDE_NET_WM_APPMENU_SERVICE_NAME` and
   `_KDE_NET_WM_APPMENU_OBJECT_PATH`, written as `STRING`/format 8. Plasma
   reads these off the window instead of asking a registrar, and runs a
   registrar _as well_ — which of the two a given version prefers is not
   something to bet a menu on.
5. **Only then** does `MenuBar` stop drawing. `RegisterWindow` returning is the
   evidence; a registrar that refuses the call leaves the menu where the user
   can still reach it.

It is followed for the life of the window, not sampled once: `NameOwnerChanged`
moves the menu into the panel when one starts and back into the window when one
exits, with no re-render on the app's part.

### The trap: activatable is not running

Ubuntu ships `com.canonical.AppMenu.Registrar` as a D-Bus **activatable**
service, so the name resolves even with no panel installed. This is the exact
opposite of the rule `hasService()` follows for portals, and getting it wrong
is silent and total — an app with no menu anywhere.

A registrar is not the feature; it is a directory the panel reads. Nothing
starts one except a panel starting up. So react-x11 asks `ListNames` for a live
owner, and every call it then makes carries D-Bus's `NO_AUTO_START` flag —
without which the tidy-up `UnregisterWindow` sent after a panel dies would
_launch a fresh registrar_, which would own the name with nothing drawing the
menus it collects.

## Seeing it work, without a desktop that has one

`com.canonical.dbusmenu` has no reference client you can install on its own —
the consumers are panel applets welded into Plasma, into `vala-panel`, or into
a GNOME extension. So there is one in this repo:

```bash
npm run globalmenu:host
```

It owns the registrar name — it _is_ the panel — and prints every menu handed
to it. In another terminal:

```bash
npm run examples:menu
```

The window's own menu bar disappears, which is the feature, and the menu
appears in the host. Type an item's id and press Enter to activate it; the
example's own state changes, and the property update comes back the other way.
Ctrl-C the host and the bar returns to the window.

On a machine that really does have a panel, `npm run globalmenu:host -- --watch`
attaches to the live registrar rather than competing for the name.

## Known limits, so they are not rediscovered as bugs

- **Stock GNOME has no global menu bar at all**, so nothing owns the registrar
  name and the in-window bar stays. That is correct rather than broken. The
  extensions that add one do own it, and then this works.
- **`ContextMenu` is not exported**, and should not be. The registrar's unit is
  a window's menu _bar_; a right-click menu belongs where the pointer is.
- **One menu per window.** The registrar's entry, the object path and the KDE
  properties all belong to the window, so a second `MenuBar` in a window that
  already has one stays drawn in the window until the first unmounts or turns
  `globalMenu` off, and only then takes the panel. A bar remounted with a new
  `key`, or switched off and on again, waits the same way for the one it
  replaces to finish leaving, which takes a round trip or two.
- **`AboutToShow` cannot be answered honestly.** dbusmenu wants a synchronous
  "do you need to rebuild this submenu", and a React `setState` has not
  rendered by the time the reply must go out. react-x11 answers `false`, runs
  `onAboutToShow`, and emits `LayoutUpdated` when the new items actually
  serialise — shells listen for that unconditionally, so a lazily-built submenu
  fills in one round trip later than a synchronous toolkit manages. Answering
  `true` instead would be worse: the shell would immediately fetch a subtree
  that has not been built and cache the old one.
- **`org.gtk.Menus`/`org.gtk.Actions` is deliberately not exported.** Handling
  both serialisations is right for a panel and wrong for an app — traffic flows
  _towards_ dbusmenu, not away from it. Plasma ships `gmenu-dbusmenu-proxy` to
  convert GTK's menus into dbusmenu, and the GNOME extensions that render
  third-party menus consume dbusmenu. A second exporter would be roughly double
  the work for no consumer the first does not already reach.

## Performance, and the one thing worth knowing

A menu is re-serialised whenever the `menus` array changes identity, which for
an app that builds it inline is every render. That part is cheap. What is not
cheap is the signal it produces, and the difference is the reason this feature
has a diff at all:

- ids and children identical, only properties differ → `ItemsPropertiesUpdated`,
  **revision unchanged**;
- structure changed → `revision++` and `LayoutUpdated(revision, parent)`, with
  `parent` the nearest common ancestor of what changed rather than `0`.

Plasma re-fetches a whole subtree on `LayoutUpdated` and only patches on
`ItemsPropertiesUpdated`. A menu whose one check mark flipped must therefore
not bump the revision — which is exactly what a naive
`setState` → `LayoutUpdated(++rev, 0)` does on every keystroke, and it turns one
property write into a re-walk of every menu in the application.

Item ids are keyed on the path of `key ?? label` down the tree — the same
identity `MenuBar` already uses for its React keys — so they survive a
re-render, and they are never reused, because a shell has properties cached
against them.

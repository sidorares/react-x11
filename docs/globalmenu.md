# The global menu

Some desktops put an application's menu bar in their own panel rather than in
its window — Unity's design, still shipped by KDE Plasma's Application Menu
widget, by `vala-panel-appmenu`, and by several GNOME extensions. On one of
those, an app that draws its own menu bar is drawing a second one.

react-x11 notices and hands the menu over. There is **nothing to configure and
nothing to call**:

```jsx
import { MenuBar } from 'react-x11';

<MenuBar
  menus={[
    {
      label: 'File',
      items: [
        { label: 'New', shortcut: [['Control', 'N']], onSelect: newFile },
        { type: 'separator' },
        { label: 'Save As…', enabled: false },
      ],
    },
  ]}
/>;
```

That is the whole of it, and it is the same line either way. Where a panel is
showing menus, `MenuBar` renders nothing and the panel shows this one; where
there is not — a stock GNOME session, XQuartz, an ssh session, a bare `startx`,
CI — it draws the bar itself, exactly as before.

## The item vocabulary is the protocol's

`menus` is a plain data prop rather than JSX children, and its item shape is
`com.canonical.dbusmenu`'s. That is what makes the rest work: **the identical
array serialises**, so there is one authoring model rather than a drawn one and
an exported one that drift apart.

| property                   | meaning                                                     |
| -------------------------- | ----------------------------------------------------------- |
| `label`                    | the row's text                                              |
| `type`                     | `'separator'` draws a rule; absent means an ordinary row    |
| `items`                    | a submenu                                                   |
| `enabled`                  | defaults to `true`; `false` dims the row and makes it inert |
| `visible`                  | defaults to `true`; `false` removes it                      |
| `shortcut`                 | `[['Control', 'S']]` — drawn, exported **and bound**        |
| `toggleType`/`toggleState` | `'checkmark'` or `'radio'`, and `0` / `1` / `-1`            |
| `iconName`                 | an icon-theme name, for the panel's menu                    |
| `iconData`                 | raw PNG bytes, for an icon that is not in a theme           |
| `disposition`              | `'normal'`, `'informative'`, `'warning'`, `'alert'`         |
| `onSelect(item)`           | runs whichever menu the click came from                     |
| `key`                      | identity, when the label is not stable                      |

`toggleState` has **three** values, not two: `-1` is _indeterminate_ — a "Bold"
that is on for part of the selection — and it draws as a dash rather than as
unchecked, because "off" is a different claim from "it depends".

`icon` is the one thing that does not cross the bus. It is a react-x11 drawing
callback ([components.md](components.md#menubar--contextmenu)) and the desktop
cannot call a function, so an item that wants an icon in both menus carries
`icon` for ours and `iconName` for the panel's.

### Shortcuts are a list, not a string

```js
shortcut: [['Control', 'S']];
```

The outer array is a list of _alternatives_; each inner one is modifier tokens
(`Control`, `Alt`, `Shift`, `Super`) ending in the key. Only the first is
drawn — a row has one shortcut column.

The key is named the way GDK names it, so `plus` rather than `+` and `Prior`
rather than `PgUp`, because that is what a panel's importer parses. Menus print
the friendly form: `[['Control', 'plus']]` draws as `Ctrl++`.

**It is a binding**, and the app writes it once. A mounted `MenuBar` answers
its own items' chords: Ctrl+S fires the item's `onSelect` without the menu
being opened, gated by that item's own `enabled` and `visible`
([events.md](events.md#accelerators)).

That matters most in exactly this case. When the panel draws the menu, the
**panel is not going to deliver the key** — it has no idea the window's
keyboard is where the user is — so the app's own window still has to, and
`MenuBar` keeps its bindings when it stops drawing. `accelerators={false}`
turns them off for an application with a dispatcher of its own.

## What happens on the wire

Enough to recognise it in `dbus-monitor`, and to know what to look at when a
menu does not appear.

1. **Detection.** Does something own `com.canonical.AppMenu.Registrar` right
   now? Only ownership counts — see the trap below.
2. **Export.** The menu is served at `/com/react_x11/menus/<xid>` on the
   process's existing bus connection ([dbus.md](dbus.md)), so the desktop sees
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

## Turning it off

```jsx
<MenuBar menus={menus} globalMenu={false} />
```

```bash
REACT_X11_NO_GLOBAL_MENU=1
```

```jsx
await createRoot({ desktop: { globalMenu: false } });
```

The prop is for one bar. The other two are process-wide: the environment
variable needs no application change, which is what a user working around a
panel that renders something badly actually has, and the `createRoot` option
is the one an embedder can reach without also setting it for every child
process it spawns — see [desktop.md](desktop.md#turning-the-desktop-off),
where `desktop: false` turns this off along with the other two integrations
that talk to the session bus.

## Drawing your own bar

`MenuBar` does all of this itself. A component that draws its own can have the
same behaviour:

```jsx
import { useGlobalMenu } from 'react-x11';

function Bar({ menus }) {
  const exported = useGlobalMenu(menus, { onSelect });
  if (exported) return null; // the panel has it
  return; /* … your bar … */
}
```

## Known limits, so they are not rediscovered as bugs

- **Stock GNOME has no global menu bar at all**, so nothing owns the registrar
  name and the in-window bar stays. That is correct rather than broken. The
  extensions that add one do own it, and then this works.
- **`ContextMenu` is not exported**, and should not be. The registrar's unit is
  a window's menu _bar_; a right-click menu belongs where the pointer is.
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
- **No bus is a first-class configuration.** Everything here degrades to
  "draw the bar" without logging: no `dbus-native` (Node 20), no
  `$DBUS_SESSION_BUS_ADDRESS`, a connection that fails. See
  [dbus.md](dbus.md).

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

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

Where the platform has somewhere to put a menu, `MenuBar` renders nothing and
the platform shows this one; where it does not, `MenuBar` draws the bar itself.

| where the menu goes                                    | when                                                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| **the macOS menu bar**, at the top of the screen       | the Cocoa backend, always                                                             |
| **the desktop's panel**, over `com.canonical.dbusmenu` | a panel is running one of the applets above                                           |
| **the window**, drawn by `MenuBar`                     | everything else — a stock GNOME session, XQuartz, an ssh session, a bare `startx`, CI |

On macOS the menu bar takes the menu as soon as `MenuBar` mounts and the drawn
fallback never renders; see
[macos.md §Menus](macos.md#menus-the-global-menu-finally-at-home).

On Linux the panel row is decided live. The menu leaves the window only once a
**running** owner of `com.canonical.AppMenu.Registrar` has accepted it (a
registrar that is merely D-Bus-activatable, as Ubuntu ships it, does not
count), and it moves into the panel when one starts and back into the window
when one exits, with no re-render on the app's part. KDE's
`_KDE_NET_WM_APPMENU_*` window properties are written as well. Design notes:
[design/globalmenu.md](../design/globalmenu.md).

## The item vocabulary is the protocol's

`menus` is a plain data prop rather than JSX children, and its item shape is
`com.canonical.dbusmenu`'s: **the identical array serialises**, so the drawn
menu and the exported one cannot drift apart.

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
that is on for part of the selection — and draws as a dash rather than as
unchecked.

`icon` is the one thing that does not cross the bus: it is a react-x11 drawing
callback ([components.md](components.md#menubar--contextmenu)), so an item that
wants an icon in both menus carries `icon` for ours and `iconName` for the
panel's.

Building `menus` inline on every render is fine: only what changed is sent to
the panel, and item identity (the path of `key ?? label`) survives re-renders.

### Shortcuts are a list, not a string

```js
shortcut: [['Control', 'S']];
```

The outer array is a list of _alternatives_; each inner one is modifier tokens
(`Control`, `Alt`, `Shift`, `Super`) ending in the key. Only the first is
drawn — a row has one shortcut column.

**On macOS, `Control` means ⌘** — the primary modifier — so `[['Control', 'S']]`
becomes ⌘S in the menu bar. `Super` maps there too; `Shift` and `Alt` are
themselves. A chord the `NSMenu` spelling cannot express is not printed beside
the item, but the binding still fires (the app's window answers it, below).
The text controls' chords, the edit menu that prints them
([events.md](events.md#primary-modifier)) and the window's own bindings
(`useAccelerator`, a drawn `MenuBar` or `ContextMenu`, which prints `⌘S` beside
the row — [events.md](events.md#the-chord)) follow the same rule.

The key is named the way GDK names it, so `plus` rather than `+` and `Prior`
rather than `PgUp`, because that is what a panel's importer parses. Menus print
the friendly form: `[['Control', 'plus']]` draws as `Ctrl++`.

**It is a binding**, and the app writes it once. A mounted `MenuBar` answers
its own items' chords: Ctrl+S fires the item's `onSelect` without the menu
being opened, gated by that item's own `enabled` and `visible`
([events.md](events.md#accelerators)).

When the panel draws the menu, the **panel does not deliver the key**, so
`MenuBar` keeps its bindings when it stops drawing. `accelerators={false}`
turns them off for an application with a dispatcher of its own.

The macOS menu bar is the one delegate that **does** deliver keys: it runs an
item on the ⌘ chord installed as its key equivalent, after the window has seen
the key. So there `MenuBar` reserves those chords — no binding in the window
answers them, its own included, and the item runs once — and keeps answering
the chords no `NSMenu` key equivalent can spell
([events.md](events.md#the-macos-menu-bar)).

## Seeing it work, without a desktop that has one

In a checkout of this repo, a stand-in panel prints every menu handed to it:

```bash
npm run globalmenu:host
```

In another terminal:

```bash
npm run examples:menu
```

The window's own menu bar disappears and the menu appears in the host. Type an
item's id and press Enter to activate it; Ctrl-C the host and the bar returns
to the window. On a machine with a real panel,
`npm run globalmenu:host -- --watch` attaches to the live registrar instead.

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
variable needs no application change (for a user working around a panel that
renders something badly), and the `createRoot` option is the one an embedder
can set without it leaking to child processes — see
[desktop.md](desktop.md#turning-the-desktop-off), where `desktop: false` turns
this off along with the other session-bus integrations.

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

- **Stock GNOME has no global menu bar at all**, so the in-window bar stays.
  The extensions that add one work.
- **`ContextMenu` is not exported** — a right-click menu belongs where the
  pointer is.
- **One menu per window.** A second `MenuBar` in a window that already has one
  stays drawn in the window until the first unmounts or turns `globalMenu`
  off, and only then takes the panel. A bar remounted with a new `key`, or
  switched off and on again, waits the same way for the one it replaces to
  finish leaving (a round trip or two).
- **A lazily-built submenu fills in one round trip late.** `onAboutToShow`
  runs when the panel opens the submenu, and the new items reach the panel
  once they have rendered.
- **`org.gtk.Menus`/`org.gtk.Actions` is not exported**; Plasma and the GNOME
  extensions consume dbusmenu.
- **No bus is a first-class configuration.** Everything here degrades to
  "draw the bar" without logging: no `dbus-native` (Node 20), no
  `$DBUS_SESSION_BUS_ADDRESS`, a connection that fails. See
  [dbus.md](dbus.md).

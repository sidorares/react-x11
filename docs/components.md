# Components

Widget components are plain React built on the host elements — no
reconciler support involved. They live in the package root export.

## `Select`

A dropdown whose menu is a real override-redirect `<popup>` window anchored
below the trigger.

```jsx
import { Select } from 'react-x11';

<Select
  width={160}
  value={color}
  options={[
    { value: '#2980b9', label: 'Blue' },
    { value: '#c0392b', label: 'Red' },
    'green', // shorthand: value === label
  ]}
  onChange={(value) => setColor(value)}
  placeholder="Pick a color…"
/>;
```

| prop                       |                                           |
| -------------------------- | ----------------------------------------- |
| `options`                  | array of `{value, label}` or plain values |
| `value`, `onChange(value)` | selection                                 |
| `placeholder`              | trigger text when nothing is selected     |
| `width` + any box props    | forwarded to the trigger box              |

Behavior: click / Space / Enter toggles the menu; Escape, focus loss, or
picking closes it; the option list scrolls when taller than 220px; the
trigger participates in Tab traversal.

Keyboard, while the trigger is focused (the popup is override-redirect and
never takes focus, so the trigger keeps handling keys with the menu open):

| key               | closed         | open                                    |
| ----------------- | -------------- | --------------------------------------- |
| `Down` / `Up`     | opens the menu | move the active option, wrapping around |
| `Home` / `End`    | —              | first / last option                     |
| `Enter` / `Space` | opens the menu | pick the active option                  |
| `Escape`          | —              | close without picking                   |

The menu opens with the current value active, hovering an option makes it
active (pointer and keyboard share one highlight), and the active option is
scrolled into view.

### Theming

```jsx
import { SelectThemeProvider } from 'react-x11';

<SelectThemeProvider
  value={{
    border: '#444',
    borderActive: '#f39c12',
    background: '#2f3640',
    text: '#f5f6fa',
    dim: '#95a5a6',
    hoverBackground: '#f39c12',
    hoverText: '#1e272e',
  }}
>
  <Select … />
</SelectThemeProvider>;
```

More components (Checkbox, Radio, Switch, …) are planned — see
NEXT_STEPS.md. The `Select` source (`src/components.js`) is the reference
for building your own: hover/focus state with `useState`, a `<popup>` for
anything that must escape the window bounds, and a ref to the trigger node
for anchoring (`node.abs` + `node.root.window.x/y`).

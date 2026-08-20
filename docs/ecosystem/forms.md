# Forms and validation

There is no `<form>` element here, so nothing submits itself — wire
`handleSubmit` to a `Button`'s `onPress` or to `<textinput onSubmit>`.

Everything else follows from **one signature**. Every value control in the
library — the host elements `<textinput>` and `<textarea>`, and the widgets
`Checkbox`, `Switch`, `RadioGroup`, `Select` and `Slider` — calls
`onChange(ev)` with a change event carrying `ev.value`, `ev.target.value`,
`ev.target.name` and, for a checkbox, `ev.target.checked`. That is the shape
every DOM form library reads, so a library's handler goes straight in:

```jsx
<textinput name="host"  value={f.values.host}   onChange={f.handleChange} />
<Checkbox  name="agree" checked={f.values.agree} onChange={f.handleChange} />
<Select    name="size"  value={f.values.size} options={sizes} onChange={f.handleChange} />
```

No adapter, no per-widget bridge, nothing to remember about which control
you are wiring.

| library                | how it goes in                                            |
| ---------------------- | --------------------------------------------------------- |
| `react-hook-form`      | `{...register('host')}`, or `<Controller>` for a widget   |
| `formik`               | `onChange={handleChange}`, `getFieldProps`, or `<Field>`  |
| `downshift`            | `getInputProps()` spread onto a `<textinput>`             |
| `@tanstack/react-form` | `onChange={(ev) => field.handleChange(ev.value)}` — below |

Every row was established by running the library headless against this
renderer rather than by reading its documentation: react-hook-form@7.84.0,
formik@2.4.9, downshift@9.4.0, @tanstack/react-form@1.33.2.

**The one thing to know**: a library whose field contract is
value-in/value-out — TanStack Form is the one here — needs the value taken
off the event, and a bare `onChange={field.handleChange}` stores the _event
object_ as the field value with no error. See below.

**Where the line falls.** A control that takes a `name` is a form field and
reports an event. `Tabs`, `Table` and the menus are not form fields
and keep their plain callbacks
([components](../components.md#the-change-event-and-name)).

## TanStack Form {#tanstack-form}

**Out of the box.** @tanstack/react-form@1.33.2 (form-core 1.33.2).

A headless, framework-agnostic form state manager: field values, dirty and
touched tracking, sync and async validation (including Standard Schema, so
zod/valibot/arktype plug in directly), and submission handling. Fields are
value-in/value-out — no DOM events, no refs.

The field contract is `field.state.value` + `field.handleChange(value)` —
a **value, not an event**. react-x11's controls fire an event, so each field
takes the value off it:

```jsx
onChange={(ev) => field.handleChange(ev.value)}
```

One expression, the same one a DOM app writes, and it is identical for a
`<textinput>` and for a `Checkbox`.

Watch for the bare form: `onChange={field.handleChange}` stores the event
object as the field's value — no error, no warning, and validation sees an
object where it expected a string.

```jsx
import React from 'react';
import { useForm } from '@tanstack/react-form';
import { Button } from 'react-x11';
import { z } from 'zod';

function ConnectForm({ connect }) {
  const form = useForm({
    defaultValues: { host: '', display: ':0' },
    onSubmit: async ({ value }) => connect(value),
  });
  return (
    <box style={{ flexDirection: 'column', gap: 8 }}>
      <form.Field
        name="host"
        validators={{ onChange: z.string().min(3, 'too short') }}
      >
        {(field) => (
          <box style={{ flexDirection: 'column' }}>
            <textinput
              value={field.state.value}
              onChange={(ev) => field.handleChange(ev.value)}
            />
            {field.state.meta.errors.length > 0 && (
              <text style={{ color: '#cc4444' }}>
                {field.state.meta.errors[0].message}
              </text>
            )}
          </box>
        )}
      </form.Field>
      <Button label="Connect" onPress={() => form.handleSubmit()} />
    </box>
  );
}
```

- No `<form>` element exists, so there is no submit-on-Enter for free. Wire
  `form.handleSubmit()` to a button's `onPress` and/or a window-level Enter
  key handler.
- The **widgets** are the exception: `Checkbox`, `Switch`, `RadioGroup`,
  `Select` and `Slider` still pass the next value first, so
  `onChange={field.handleChange}` is right there and needs no unwrap. Only
  the host elements `<textinput>`/`<textarea>` changed.
- Validation errors from a zod schema are error _objects_
  (`errors[0].message`), not strings; a plain string validator returns
  strings. A `<text>` child must be a string, so render `.message`.
- The package also ships SSR and Next helpers under subpaths; the root
  import used here pulls in no react-dom.

## zod {#zod}

**Out of the box.** zod@4.4.3.

TypeScript-first schema validation. Pure computation, no DOM, nothing
renderer-specific — the interesting part is only where it plugs in:

- **TanStack Form** — pass a schema straight into a field's
  `validators: { onChange: z.string().min(3, 'too short') }`. Zod 4
  implements Standard Schema, so no resolver package is needed.
- **React Hook Form** — via `@hookform/resolvers/zod`, with either
  `register()` or `Controller`; see below.
- **Standalone** — validating a settings file or a config blob before
  rendering is just `schema.safeParse(data)`.

```jsx
import { z } from 'zod';

const settings = z.object({
  display: z.string().regex(/^:\d+$/, 'DISPLAY looks like :0'),
  scale: z.coerce.number().min(0.5).max(3).default(1),
});

function Settings({ raw }) {
  const parsed = settings.safeParse(raw);
  if (!parsed.success) {
    // render the issues instead of crashing the app
    return (
      <box style={{ flexDirection: 'column' }}>
        {parsed.error.issues.map((i) => (
          <text
            key={i.path.join('.')}
          >{`${i.path.join('.')}: ${i.message}`}</text>
        ))}
      </box>
    );
  }
  return <text>display {parsed.data.display}</text>;
}
```

- Zod 4 field errors surface as issue objects; render `issue.message`, not
  the issue itself.
- `valibot` and `arktype` are equally viable (also Standard Schema). zod is
  documented here because both verified form integrations used it.
- Bundle-size arguments from the web world do not apply — an X11 app ships
  no bundle.

## React Hook Form {#react-hook-form}

**Out of the box, both APIs.** react-hook-form@7.84.0 with
@hookform/resolvers@5.5.7.

RHF's headline API is uncontrolled-first: `register()` returns DOM-shaped
props (`{name, ref, onChange(e), onBlur(e)}`) and reads `e.target.value` off
the event. That is exactly what `<textinput>` provides, so the terse spread
works:

```jsx
const { register, handleSubmit } = useForm({ defaultValues: { host: '' } });
<textinput {...register('host')} />;
```

Three things had to line up, and all three now do: `name` exists as a prop,
`onChange` receives an event whose `target.value` is the new text, and the
`ref` RHF attaches lands on a node whose `value` is **writable** — RHF
assigns `ref.value = ''` while registering the field, which used to throw
`TypeError: Cannot set property value of #<TextInputNode> which has only a
getter` from inside the commit phase and take the render down with it.

Verified working through `register()`: typing updates `getValues()`,
`handleSubmit` receives them, `setValue(name, v)` writes through the ref so
the field redraws, and `setFocus(name)` focuses the node.

One asymmetry to know about: **`reset()` updates form state but does not
clear an uncontrolled field's text.** RHF only writes values back through
refs on the reset path when its `isWeb` probe
(`typeof window !== 'undefined' && window.HTMLElement && document`) passes,
which it never does here. `setValue()` is not gated that way and does write
through. If you need `reset()` to clear the display, make the field
controlled — `<Controller>`, below — or assign `ref.current.value = ''`
yourself.

`<Controller>` / `useController` still works, unchanged, and is the better
choice when you want the field controlled. `field.onChange` accepts either a
plain value or an event, so both of these are fine:

```jsx
onChange={(ev) => field.onChange(ev.target.value)}   // explicit
onChange={field.onChange}                            // RHF unwraps .target
```

```jsx
import React from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from 'react-x11';
import { z } from 'zod';

const schema = z.object({
  host: z.string().min(3, 'too short'),
  display: z.string(),
});

function ConnectForm({ connect }) {
  const { control, handleSubmit } = useForm({
    defaultValues: { host: '', display: ':0' },
    resolver: zodResolver(schema),
    mode: 'onChange',
  });
  return (
    <box style={{ flexDirection: 'column', gap: 8 }}>
      <Controller
        name="host"
        control={control}
        render={({ field, fieldState }) => (
          <box style={{ flexDirection: 'column' }}>
            <textinput
              value={field.value}
              onChange={field.onChange}
              onBlur={field.onBlur}
            />
            {fieldState.error && <text>{fieldState.error.message}</text>}
          </box>
        )}
      />
      <Button label="Connect" onPress={handleSubmit(connect)} />
    </box>
  );
}
```

- A `Controller` field is controlled, so its subtree re-renders on every
  keystroke. `register()` does not, which is the same performance argument
  RHF makes on the web — and it now applies here too.
- `setFocus(name)` works: it calls `.focus()` on whatever the ref holds, and
  a `<textinput>` node has one.
- `handleSubmit` returns a function. Call it: `handleSubmit(fn)` in an
  `onPress` is the curried form, and there is no submit event to pass.

## Formik {#formik}

**Out of the box.** formik@2.4.9.

Formik was the clearest casualty of the old `onChange(string)` contract, and
it failed _silently_: `handleChange` treats a string argument as its curried
field-name form, returns a handler, and never touches state — so spreading
`getFieldProps` onto a `<textinput>` left `values` at its initial object and
`touched` empty, with nothing logged. That is fixed by the event, not by an
adapter. All three of Formik's field styles now work:

```jsx
import { Formik, Field, useFormik } from 'formik';

// 1. the spread
<textinput {...formik.getFieldProps('host')} />

// 2. by hand
<textinput
  name="host"
  value={formik.values.host}
  onChange={formik.handleChange}
  onBlur={formik.handleBlur}
/>

// 3. <Field> with a render prop
<Field name="host">
  {({ field }) => <textinput {...field} />}
</Field>
```

`handleChange` reads `target.name` to decide which field to write, so the
`name` prop is not optional in any of these — that is what the synthetic
event carries it for.

The widgets need no bridge — same handler, same signature:

```jsx
<Checkbox
  name="agree"
  checked={formik.values.agree}
  onChange={formik.handleChange}
>
  I agree
</Checkbox>
```

`ev.target` is `{ type: 'checkbox', name, value, checked }`, which is exactly
what `handleChange` destructures — including `type`, which is how it knows to
take `checked` rather than `value`.

- `<Formik>`'s render-prop form and `useFormik` both work; there is no
  `<form>` element, so call `submitForm()` (or `handleSubmit()`) yourself
  from a `Button` or from `<textinput onSubmit>`.
- Passing a non-event object to `handleChange` — a hand-rolled fake event
  with no `target` — still throws `TypeError: Cannot read properties of
undefined (reading 'type')` rather than no-opping. Pass the real event.

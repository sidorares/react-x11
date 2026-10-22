# Forms and validation

There is no `<form>` element, so nothing submits itself — wire
`handleSubmit` to a `Button`'s `onPress` or to `<textinput onSubmit>`.

Everything else follows from **one signature**. Every value control — the
host elements `<textinput>` and `<textarea>`, and the widgets `Checkbox`,
`Switch`, `RadioGroup`, `Select` and `Slider` — calls `onChange(ev)` with a
change event carrying `ev.value`, `ev.target.value`, `ev.target.name` and,
for a checkbox, `ev.target.checked`. That is the shape DOM form libraries
read, so a library's handler goes straight in, with no per-widget bridge:

```jsx
<textinput name="host"  value={f.values.host}   onChange={f.handleChange} />
<Checkbox  name="agree" checked={f.values.agree} onChange={f.handleChange} />
<Select    name="size"  value={f.values.size} options={sizes} onChange={f.handleChange} />
```

| library                | how it goes in                                            |
| ---------------------- | --------------------------------------------------------- |
| `react-hook-form`      | `{...register('host')}`, or `<Controller>` for a widget   |
| `formik`               | `onChange={handleChange}`, `getFieldProps`, or `<Field>`  |
| `downshift`            | `getInputProps()` spread onto a `<textinput>`             |
| `@tanstack/react-form` | `onChange={(ev) => field.handleChange(ev.value)}` — below |

Each row was run headless against the renderer: react-hook-form@7.84.0,
formik@2.4.9, downshift@9.4.0, @tanstack/react-form@1.33.2.

**The one thing to know**: a library whose field contract is
value-in/value-out — TanStack Form here — needs the value taken off the
event; a bare `onChange={field.handleChange}` stores the _event object_ as
the field value with no error.

A control that takes a `name` is a form field and reports an event. `Tabs`,
`Table` and the menus are not, and keep their plain callbacks
([components](../components.md#the-change-event-and-name)).

## TanStack Form {#tanstack-form}

**Out of the box.** @tanstack/react-form@1.33.2 (form-core 1.33.2).

A headless form state manager: field values, dirty and touched tracking,
sync and async validation (Standard Schema, so zod/valibot/arktype plug in
directly), and submission. The field contract is `field.state.value` +
`field.handleChange(value)` — a **value, not an event** — so each field
takes the value off the control's event, the same expression a DOM app
writes, for a `<textinput>` and a `Checkbox` alike:

```jsx
onChange={(ev) => field.handleChange(ev.value)}
```

The bare `onChange={field.handleChange}` stores the event object as the
field's value — no error, no warning, and validation sees an object where it
expected a string.

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

- There is no submit-on-Enter for free. Wire `form.handleSubmit()` to a
  button's `onPress` and/or a window-level Enter key handler.
- Validation errors from a zod schema are error _objects_
  (`errors[0].message`); a plain string validator returns strings. A
  `<text>` child must be a string, so render `.message`.
- The SSR and Next helpers live under subpaths; the root import pulls in no
  react-dom.

## zod {#zod}

**Out of the box.** zod@4.4.3.

Schema validation, pure computation. Where it plugs in:

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
- `valibot` and `arktype` are equally viable (also Standard Schema).
- Bundle-size arguments from the web do not apply — an X11 app ships no
  bundle.

## React Hook Form {#react-hook-form}

**Out of the box, both APIs.** react-hook-form@7.84.0 with
@hookform/resolvers@5.5.7.

`register()` returns DOM-shaped props (`{name, ref, onChange(e),
onBlur(e)}`) and reads `e.target.value` off the event, which is what
`<textinput>` provides, so the spread works:

```jsx
const { register, handleSubmit } = useForm({ defaultValues: { host: '' } });
<textinput {...register('host')} />;
```

The `ref` RHF attaches lands on a node whose `value` is writable (RHF
assigns `ref.value = ''` while registering). Through `register()`, typing
updates `getValues()`, `handleSubmit` receives the values,
`setValue(name, v)` writes through the ref so the field redraws, and
`setFocus(name)` calls the node's `.focus()`.

**`reset()` updates form state but does not clear an uncontrolled field's
text.** RHF writes values back through refs on reset only when its `isWeb`
probe (`typeof window !== 'undefined' && window.HTMLElement && document`)
passes, which it never does here; `setValue()` is not gated. To have
`reset()` clear the display, make the field controlled with `<Controller>`,
or assign `ref.current.value = ''` yourself.

`<Controller>` / `useController` is the choice for a controlled field.
`field.onChange` accepts a plain value or an event, so both are fine:

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

- A `Controller` field re-renders its subtree on every keystroke;
  `register()` does not — the same performance argument RHF makes on the
  web.
- `handleSubmit` returns a function. Call it: `handleSubmit(fn)` in an
  `onPress` is the curried form, and there is no submit event to pass.

## Formik {#formik}

**Out of the box.** formik@2.4.9.

All three of Formik's field styles work:

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
`name` prop is required in all of these. The widgets take the same handler:

```jsx
<Checkbox
  name="agree"
  checked={formik.values.agree}
  onChange={formik.handleChange}
>
  I agree
</Checkbox>
```

`ev.target` is `{ type: 'checkbox', name, value, checked }`, which is what
`handleChange` destructures — `type` is how it knows to take `checked`.

- `<Formik>`'s render-prop form and `useFormik` both work; there is no
  `<form>` element, so call `submitForm()` (or `handleSubmit()`) yourself
  from a `Button` or from `<textinput onSubmit>`.
- Passing `handleChange` a non-event object — a hand-rolled fake event with
  no `target` — throws
  `TypeError: Cannot read properties of undefined (reading 'type')` rather
  than no-opping. Pass the real event.

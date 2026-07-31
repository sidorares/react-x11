# Forms and validation

There is no `<form>` element here, and `<textinput>` fires
`onChange(newString)` rather than `onChange(event)` — see
[elements](../elements.md). Those two facts sort the form libraries
cleanly: the ones with a value-in/value-out field contract work unmodified,
the ones built on `register()`-style DOM prop bags need their controlled
API, and the ones that only have the DOM path do not work at all.

Formik is in the last group, and it is the one that costs people the most
time because one of its two failure modes is silent. It is written up in the
[negative-results register](../ecosystem.md#first-interaction).

## TanStack Form {#tanstack-form}

**Out of the box.** @tanstack/react-form@1.33.2 (form-core 1.33.2).

A headless, framework-agnostic form state manager: field values, dirty and
touched tracking, sync and async validation (including Standard Schema, so
zod/valibot/arktype plug in directly), and submission handling. Fields are
value-in/value-out — no DOM events, no refs.

The field contract is `field.state.value` + `field.handleChange(value)`, and
`<textinput>` fires `onChange(text)` with the raw string. They meet in the
middle with no glue at all, which makes this the form library to reach for
first.

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
              onChange={field.handleChange}
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
- `Checkbox` and `Select` take `onChange(checked)`/`onChange(value)`, so
  `field.handleChange` works across the widget set — but confirm the value
  shape per component.
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
- **React Hook Form** — via `@hookform/resolvers/zod` and the `Controller`
  pattern below.
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

**Adapter — use `<Controller>`, not `register()`.** react-hook-form@7.83.0
with @hookform/resolvers@5.5.7.

RHF's headline API is uncontrolled-first: `register()` returns DOM-shaped
props (`{name, ref, onChange(e), onBlur(e)}`) and reads `e.target.value` off
native events. That path is unusable here — `<textinput onChange>` passes a
raw string, and there is no `name` prop or DOM ref to attach.

But RHF has always shipped a second, controlled API — `<Controller>` /
`useController` — for external controlled components, and that path never
touches the DOM. It works today with **zero adapter code**, because
`field.onChange` accepts a plain value; RHF only unwraps `.target` when the
argument actually looks like an event. RHF guards all its DOM checks behind
`isWeb = typeof window !== 'undefined'`, so headless Node is a supported
environment rather than an accident.

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
              onChange={field.onChange} // raw string in — no event unwrap needed
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

- Every field needs the `Controller` wrapper (or `useController`). The
  `register()` spread that makes RHF terse on the web is off the table, and
  with it the uncontrolled-inputs performance story: every controlled field
  re-renders its `Controller` subtree on keystroke.
- `setFocus(name)` is a no-op — it wants a DOM ref with `.focus()`. Use
  react-x11's own focus handling instead.
- `handleSubmit` returns a function. Call it: `handleSubmit(fn)` in an
  `onPress` is the curried form, and there is no submit event to pass.

# Forms and validation: design notes

Contributor-only, not shipped and not on the website. These sections were
moved out of [docs/ecosystem/forms.md](../../docs/ecosystem/forms.md), the
reference, and keep their original headings so code comments that cite them
still resolve.

## zod {#zod}

- `valibot` and `arktype` are equally viable (also Standard Schema). zod is
  documented here because both verified form integrations used it.

## React Hook Form {#react-hook-form}

Three things had to line up, and all three now do: `name` exists as a prop,
`onChange` receives an event whose `target.value` is the new text, and the
`ref` RHF attaches lands on a node whose `value` is **writable** — RHF
assigns `ref.value = ''` while registering the field, which used to throw
`TypeError: Cannot set property value of #<TextInputNode> which has only a
getter` from inside the commit phase and take the render down with it.

## Formik {#formik}

Formik was the clearest casualty of the old `onChange(string)` contract, and
it failed _silently_: `handleChange` treats a string argument as its curried
field-name form, returns a handler, and never touches state — so spreading
`getFieldProps` onto a `<textinput>` left `values` at its initial object and
`touched` empty, with nothing logged. That is fixed by the event, not by an
adapter.

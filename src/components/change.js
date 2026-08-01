// The change event the widgets pass as their `onChange`'s *second*
// argument.
//
// The host elements `<textinput>`/`<textarea>` hand their handler a single
// synthetic event (issue #115). The widgets cannot: `onChange={setChecked}`
// is the whole ergonomic point of them, and the next value has to stay the
// first argument. So the event is additive — the first argument is the
// value, the second is this — which is enough for a form library, because
// every one of them reads the field out of `ev.target`.
//
// `target` is a plain descriptor rather than a node: a widget is a
// composition of nodes with no single element holding its value, and
// `{ type, name, value, checked }` is exactly the shape formik's
// `handleChange` and react-hook-form's `getEventValue` destructure. `type`
// is what tells them a checkbox from a text field, which is why it is set
// even though nothing in react-x11 reads it.
//
// There is no `preventDefault` — the value has already changed by the time
// the handler runs, so there would be nothing to prevent.

/**
 * @param {string} type - `'checkbox'`, `'radio'`, `'select-one'`, `'range'`…
 * @param {string|undefined} name - the widget's `name` prop
 * @param {unknown} value - the value the widget just moved to
 */
export function changeEvent(type, name, value) {
  const target = { type, name, value };
  if (type === 'checkbox') target.checked = Boolean(value);
  return { type: 'change', target, currentTarget: target, name, value };
}

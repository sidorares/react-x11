// The change event the value widgets hand their `onChange`.
//
// One signature across the library: `<textinput>` and `<textarea>` pass a
// synthetic event, and so do `Checkbox`, `Switch`, `RadioGroup`, `Select`
// and `Slider`. That is what lets `onChange={formik.handleChange}` be wired
// to any of them without a per-widget adapter — a form library reads the
// field out of `ev.target`, and it now finds one there whatever it is
// attached to.
//
// The line is `name`: a widget that takes one is a form field and reports an
// event. `Tabs`, `Table` and the menus are not form fields and keep
// their plain callbacks.
//
// `target` is a plain descriptor rather than a node, which is the one place
// this differs from the host elements. A widget is a composition of nodes
// with no single element holding its value, so there is nothing honest to
// point at — and `{ type, name, value, checked }` is exactly the shape
// formik's `handleChange` and react-hook-form's event reader destructure.
// `type` is what tells them a checkbox from a text field, which is why it is
// set even though nothing in react-x11 reads it.
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

// A small form, exercising the widget set the way an app would: <textinput>
// with autoFocus, a <Select> dropdown (a real <popup> window), a RadioGroup,
// a Slider and a Checkbox — submit with Enter or the button, and the result
// is styled by what you picked. "Clear" opens a <Dialog>: a modal popup that
// traps Tab, closes on Escape, and hands focus back to the button that
// opened it.
// Run with: npm run examples:form  (needs an X server / DISPLAY), or as a
// macOS app bundle: npm run examples:form:app — see make-app.sh beside this.
import React, { useState } from 'react';
import {
  Button,
  Checkbox,
  createRoot,
  Dialog,
  Radio,
  RadioGroup,
  Select,
  Slider,
} from '../../src/index.js';

const COLORS = [
  { value: '#2980b9', label: 'Blue' },
  { value: '#c0392b', label: 'Red' },
  { value: '#27ae60', label: 'Green' },
  { value: '#8e44ad', label: 'Purple' },
];

const WEIGHTS = ['normal', 'bold'];

/** The form itself, without a window round it — so examples/app.jsx can
 * show it in a tab. */
export function FormPanel() {
  const [name, setName] = useState('');
  const [color, setColor] = useState('#2980b9');
  const [size, setSize] = useState(20);
  const [weight, setWeight] = useState('normal');
  const [shout, setShout] = useState(false);
  const [greeting, setGreeting] = useState(null);
  const [confirming, setConfirming] = useState(false);

  const submit = () =>
    setGreeting({
      name: name.trim() || 'stranger',
      color,
      size,
      weight,
      shout,
    });

  const clear = () => {
    setName('');
    setShout(false);
    setGreeting(null);
    setConfirming(false);
  };

  return (
    <box style={{ flexGrow: 1, padding: 16, gap: 12 }}>
      <text style={{ fontSize: 20, color: '$text' }}>Sign the guestbook</text>

      <textinput
        autoFocus
        value={name}
        placeholder="Your name"
        onChange={(ev) => setName(ev.target.value)}
        onSubmit={submit}
        style={{
          // the palette's own control padding, which is what makes this
          // field exactly as tall as the Select and the buttons under it —
          // a field's box is its capitals, the same as a label's
          paddingTop: '$paddingY',
          paddingBottom: '$paddingY',
          paddingLeft: 10,
          paddingRight: 10,
          borderRadius: '$radius',
          borderWidth: '$borderWidth',
          borderColor: '$border',
          backgroundColor: '$surface',
        }}
      />

      <box style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Select
          options={COLORS}
          value={color}
          onChange={(ev) => setColor(ev.value)}
          style={{ flexGrow: 1 }}
        />
        <RadioGroup
          value={weight}
          onChange={(ev) => setWeight(ev.value)}
          style={{ flexDirection: 'row', gap: 12 }}
        >
          {WEIGHTS.map((w) => (
            <Radio key={w} value={w} label={w} />
          ))}
        </RadioGroup>
      </box>

      <box style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <text style={{ color: '$textMuted' }}>size</text>
        <Slider
          min={12}
          max={32}
          value={size}
          onChange={(ev) => setSize(ev.value)}
          style={{ flexGrow: 1 }}
        />
        <text style={{ color: '$textMuted' }}>{String(size)}</text>
      </box>

      <box style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Checkbox
          checked={shout}
          onChange={(ev) => setShout(ev.value)}
          label="Shout it"
        />
        <box style={{ flexGrow: 1 }} />
        <Button label="Clear" onPress={() => setConfirming(true)} />
        <Button primary label="Sign" onPress={submit} />
      </box>

      <Dialog
        open={confirming}
        title="Clear the form?"
        onClose={() => setConfirming(false)}
        width={320}
        height={150}
        actions={
          <>
            <Button label="Cancel" onPress={() => setConfirming(false)} />
            <Button primary autoFocus label="Clear" onPress={clear} />
          </>
        }
      >
        The name and the greeting below it will be discarded.
      </Dialog>

      <box
        style={{
          flexGrow: 1,
          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        {greeting && (
          <text
            style={{
              fontSize: greeting.size,
              fontWeight: greeting.weight,
              color: greeting.color,
            }}
          >
            {greeting.shout
              ? `HELLO, ${greeting.name.toUpperCase()}!`
              : `Hello, ${greeting.name}!`}
          </text>
        )}
      </box>
    </box>
  );
}

function App() {
  return (
    <window
      width={420}
      height={380}
      title="form"
      style={{ backgroundColor: '$surfaceHover' }}
    >
      <FormPanel />
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<App />);
}

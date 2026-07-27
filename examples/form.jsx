// A small form, exercising the widget set the way an app would: <textinput>
// with autoFocus, a <Select> dropdown (a real <popup> window), a RadioGroup,
// a Slider and a Checkbox — submit with Enter or the button, and the result
// is styled by what you picked. "Clear" opens a <Dialog>: a modal popup that
// traps Tab, closes on Escape, and hands focus back to the button that
// opened it.
// Run with: npm run examples:form  (needs an X server / DISPLAY)
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
} from '../src/index.js';

const COLORS = [
  { value: '#2980b9', label: 'Blue' },
  { value: '#c0392b', label: 'Red' },
  { value: '#27ae60', label: 'Green' },
  { value: '#8e44ad', label: 'Purple' },
];

const WEIGHTS = ['normal', 'bold'];

function App() {
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
    <window width={420} height={380} title="form" backgroundColor="#f5f6fa">
      <box flexGrow={1} padding={16} gap={12}>
        <text fontSize={20} color="#2d3436">
          Sign the guestbook
        </text>

        <textinput
          autoFocus
          value={name}
          placeholder="Your name"
          onChange={setName}
          onSubmit={submit}
          padding={8}
          borderRadius={4}
          borderWidth={1}
          borderColor="#b2bec3"
          backgroundColor="white"
        />

        <box flexDirection="row" alignItems="center" gap={12}>
          <Select
            flexGrow={1}
            options={COLORS}
            value={color}
            onChange={setColor}
          />
          <RadioGroup
            value={weight}
            onChange={setWeight}
            flexDirection="row"
            gap={12}
          >
            {WEIGHTS.map((w) => (
              <Radio key={w} value={w} label={w} />
            ))}
          </RadioGroup>
        </box>

        <box flexDirection="row" alignItems="center" gap={12}>
          <text color="#636e72">size</text>
          <Slider
            flexGrow={1}
            min={12}
            max={32}
            value={size}
            onChange={setSize}
          />
          <text color="#636e72">{String(size)}</text>
        </box>

        <box flexDirection="row" alignItems="center" gap={12}>
          <Checkbox checked={shout} onChange={setShout} label="Shout it" />
          <box flexGrow={1} />
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

        <box flexGrow={1} justifyContent="center" alignItems="center">
          {greeting && (
            <text
              fontSize={greeting.size}
              fontWeight={greeting.weight}
              color={greeting.color}
            >
              {greeting.shout
                ? `HELLO, ${greeting.name.toUpperCase()}!`
                : `Hello, ${greeting.name}!`}
            </text>
          )}
        </box>
      </box>
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<App />);
}

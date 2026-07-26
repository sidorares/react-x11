// A small form: <textinput> + the <Select> widget component (dropdown built
// on <popup>), submit via Enter or button, result styled by the selections.
// Run with: npm run examples:form  (needs an X server / DISPLAY)
import React, { useState } from 'react';
import { Button, createRoot, Select } from '../src/index.js';

const COLORS = [
  { value: '#2980b9', label: 'Blue' },
  { value: '#c0392b', label: 'Red' },
  { value: '#27ae60', label: 'Green' },
  { value: '#8e44ad', label: 'Purple' },
];

const SIZES = [
  { value: 14, label: 'Small' },
  { value: 20, label: 'Medium' },
  { value: 28, label: 'Large' },
];

function App() {
  const [name, setName] = useState('');
  const [color, setColor] = useState('#2980b9');
  const [size, setSize] = useState(20);
  const [greeting, setGreeting] = useState(null);

  const submit = () =>
    setGreeting({ name: name.trim() || 'stranger', color, size });

  return (
    <window width={400} height={320} title="form" backgroundColor="#f5f6fa">
      <box flexGrow={1} padding={16} gap={12}>
        <text fontSize={20} color="#2d3436">
          Sign the guestbook
        </text>

        <textinput
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

        <box flexDirection="row" gap={12}>
          <Select
            flexGrow={1}
            options={COLORS}
            value={color}
            onChange={setColor}
          />
          <Select
            flexGrow={1}
            options={SIZES}
            value={size}
            onChange={setSize}
          />
        </box>

        <box flexDirection="row">
          <Button primary label="Sign" onPress={submit} />
        </box>

        <box flexGrow={1} justifyContent="center" alignItems="center">
          {greeting && (
            <text fontSize={greeting.size} color={greeting.color}>
              Hello, {greeting.name}!
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

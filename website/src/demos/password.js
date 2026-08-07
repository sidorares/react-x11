export default {
  id: 'password',
  title: 'A password field that scribbles',
  description:
    'Bullets report how many characters you have typed — countably, from ' +
    'across the room — and say almost nothing about the keystroke that just ' +
    'landed. PasswordInput draws one stroke through points seeded from the ' +
    'window and the value, so every keystroke redraws the whole curve, and ' +
    'nothing in the shape is per-character. Click the field and type.',
  code: `import React, { useState } from 'react';
import { createRoot, Button, PasswordInput } from 'react-x11';

function App() {
  const [secret, setSecret] = useState('');
  const [signedIn, setSignedIn] = useState(false);

  return (
    <window x={30} y={30} width={460} height={300} title="sign in"
            style={{ backgroundColor: '#f1f2f6' }}>
      <box style={{ padding: 20, gap: 14 }}>
        <text style={{ fontSize: 18 }}>Sign in</text>

        <PasswordInput
          value={secret}
          onChange={(ev) => setSecret(ev.value)}
          onSubmit={() => setSignedIn(true)}
          placeholder="Password"
          style={{ backgroundColor: '#eef4fb', width: 300 }}
        />

        <box style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
          <text style={{ fontSize: 13, color: '#7f8c8d' }}>as bullets:</text>
          <text style={{ fontSize: 13 }}>{'•'.repeat([...secret].length)}</text>
        </box>

        <box style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
          <Button primary onPress={() => setSignedIn(true)}>Sign in</Button>
          <Button onPress={() => { setSecret(''); setSignedIn(false); }}>
            Clear
          </Button>
          <text style={{ fontSize: 12, color: '#7f8c8d' }}>
            {signedIn ? [...secret].length + ' characters submitted' : ''}
          </text>
        </box>

        <text style={{ fontSize: 11, color: '#7f8c8d' }}>
          The width grows with what you type, by an uneven step — so it is
          feedback, not a ruler. Ctrl+U clears, Ctrl+V pastes, the eye reveals
          while you are in the field, and there is deliberately no copy.
        </text>
      </box>
    </window>
  );
}

const root = await createRoot();
root.render(<App />);
`,
};

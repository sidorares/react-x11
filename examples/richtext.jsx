// Rich content elements: <markdown> (with highlighted + math fences) in a
// scrollview, a live-updating <tex> formula, a declarative JSX <svg> and an
// <image> — all drawn client-side through ntk's document widgets and image
// pipeline.
//
// "open a .md…" is the file dialog (`useFileDialog()`), pointed at a real
// file and rendered by the same <markdown> element — the shortest honest
// demonstration of why an app wants one.
//
// Run with: npm run examples:richtext  (needs an X server)
import { fileURLToPath } from 'node:url';

import React, { useRef, useState } from 'react';
import { Button, createRoot, useFileDialog } from '../src/index.js';

// any PNG/JPEG path works; this one ships with the docs
const PICTURE = fileURLToPath(
  new URL('../docs/img/three.png', import.meta.url),
);

const MARKDOWN = `# react-x11 rich content

Everything below is one \`<markdown>\` element (content as a string
child, react-markdown style) — ntk's **MarkdownView** wrapped in a yoga
measure function, scrolling inside a \`<scrollview>\`.

## Code

\`\`\`js
const root = await createRoot();
root.render(<markdown onLink={openBrowser}>{README}</markdown>);
\`\`\`

## Math

\`\`\`math
\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}
\`\`\`

## Tables & links

| element      | widget       |
| ------------ | ------------ |
| \`<markdown>\` | MarkdownView |
| \`<html>\`     | HtmlView     |
| \`<svg>\`      | SvgView      |
| \`<tex>\`      | layoutTex    |

Click [the ntk repository](https://github.com/sidorares/ntk) — links
dispatch \`onLink\`.
`;

// Declarative SVG, like React DOM: elements as JSX children, camelCase
// props, re-rendered on any prop/state change.
function Logo({ spin }) {
  const orbit = (angle) => (
    <ellipse
      cx={12}
      cy={12}
      rx={10}
      ry={4}
      fill="none"
      stroke="#2980b9"
      strokeWidth={1}
      transform={`rotate(${angle + spin} 12 12)`}
    />
  );
  return (
    <svg viewBox="0 0 24 24" style={{ width: 40, height: 40 }}>
      <circle cx={12} cy={12} r={10} fill="#61dafb" opacity={0.25} />
      {orbit(0)}
      {orbit(60)}
      {orbit(120)}
      <circle cx={12} cy={12} r={2} fill="#c0392b" />
    </svg>
  );
}

function App() {
  const [n, setN] = useState(2);
  const [doc, setDoc] = useState({ source: MARKDOWN, from: null });
  const win = useRef(null);

  // The dialog is one call and one `null` check — and it is the desktop's own
  // dialog, `NSOpenPanel` on a Mac, or one react-x11 draws, depending only on
  // what the machine has. See docs/filedialog.md.
  const { openFile } = useFileDialog({ parentWindow: win });
  const load = async () => {
    const files = await openFile({
      title: 'Open a Markdown file',
      filters: [
        { name: 'Markdown', extensions: ['md', 'markdown'] },
        { name: 'Text', extensions: ['txt'] },
      ],
    });
    if (!files) return; // cancelled
    const { readFile } = await import('node:fs/promises');
    try {
      setDoc({ source: await readFile(files[0], 'utf8'), from: files[0] });
    } catch (err) {
      setDoc({
        source: `# Could not read that file\n\n\`${err.message}\``,
        from: null,
      });
    }
  };

  return (
    <window
      ref={win}
      width={560}
      height={640}
      title={doc.from ? `rich content — ${doc.from}` : 'rich content'}
      style={{ backgroundColor: 'white' }}
    >
      <box
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          padding: 12,
          backgroundColor: '#f4f4f4',
        }}
      >
        <Logo spin={n * 15} />
        <tex size={26} displayMode>
          {`e^{i\\pi} + 1 = 0 \\qquad x^{${n}}`}
        </tex>
        <box style={{ flexGrow: 1 }} />
        <Button label="open a .md…" onPress={load} />
        <Button
          primary
          label="bump exponent"
          onPress={() => setN((v) => (v % 9) + 1)}
        />
      </box>
      <scrollview style={{ flexGrow: 1 }}>
        <markdown
          onLink={(href) => console.log('link clicked:', href)}
          style={{ padding: 16 }}
        >
          {doc.source}
        </markdown>
      </scrollview>

      <box
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          padding: 12,
          backgroundColor: '#f4f4f4',
        }}
      >
        {/* <image> decodes PNG/JPEG through ntk and uploads once; with only
            one dimension given it keeps the aspect ratio */}
        <image src={PICTURE} style={{ height: 64, borderRadius: 4 }} />
        <text style={{ color: '#636e72' }}>
          {
            '<image> — PNG/JPEG, sized by the layout, uploaded to the server once'
          }
        </text>
      </box>
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<App />);
}

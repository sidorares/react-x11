// Rich content elements: <markdown> (with mermaid + math fences) in a
// scrollview, a live-updating <tex> formula, and a declarative JSX <svg>
// — all drawn client-side through ntk's document widgets.
// Run with: npm run examples:richtext  (needs an X server / DISPLAY)
import React, { useState } from 'react';
import { createRoot } from '../src/index.js';

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

## Mermaid

Parses asynchronously; the element reflows when the model arrives
(ntk's \`onInvalidate\` hook):

\`\`\`mermaid
flowchart LR
  A[React tree] --> B[retained nodes]
  B --> C[yoga layout]
  C --> D((XRender))
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
    <svg viewBox="0 0 24 24" width={40} height={40}>
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
  return (
    <window
      width={560}
      height={640}
      title="rich content"
      backgroundColor="white"
    >
      <box
        flexDirection="row"
        alignItems="center"
        gap={12}
        padding={12}
        backgroundColor="#f4f4f4"
      >
        <Logo spin={n * 15} />
        <tex size={26} displayMode>
          {`e^{i\\pi} + 1 = 0 \\qquad x^{${n}}`}
        </tex>
        <box flexGrow={1} />
        <box
          backgroundColor="#3498db"
          borderRadius={6}
          padding={8}
          cursor="pointer"
          onClick={() => setN((v) => (v % 9) + 1)}
        >
          <text color="white">bump exponent</text>
        </box>
      </box>
      <scrollview flexGrow={1}>
        <markdown
          padding={16}
          onLink={(href) => console.log('link clicked:', href)}
        >
          {MARKDOWN}
        </markdown>
      </scrollview>
    </window>
  );
}

const root = await createRoot();
root.render(<App />);

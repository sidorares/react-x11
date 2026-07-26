// Rich content elements: <markdown> (with mermaid + math fences) in a
// scrollview, a live-updating <tex> formula, and an inline <svg> — all
// drawn client-side through ntk's document widgets.
// Run with: npm run examples:richtext  (needs an X server / DISPLAY)
import React, { useState } from 'react';
import { createRoot } from '../src/index.js';

const MARKDOWN = `# react-x11 rich content

Everything below is one \`<markdown source>\` element — ntk's
**MarkdownView** wrapped in a yoga measure function, scrolling inside a
\`<scrollview>\`.

## Code

\`\`\`js
const root = await createRoot();
root.render(<markdown source={README} onLink={openBrowser} />);
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

const LOGO = `<svg viewBox="0 0 24 24">
  <circle cx="12" cy="12" r="10" fill="#61dafb" opacity="0.25"/>
  <ellipse cx="12" cy="12" rx="10" ry="4" fill="none" stroke="#2980b9" stroke-width="1"/>
  <ellipse cx="12" cy="12" rx="10" ry="4" fill="none" stroke="#2980b9" stroke-width="1" transform="rotate(60 12 12)"/>
  <ellipse cx="12" cy="12" rx="10" ry="4" fill="none" stroke="#2980b9" stroke-width="1" transform="rotate(120 12 12)"/>
  <circle cx="12" cy="12" r="2" fill="#c0392b"/>
</svg>`;

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
        <svg source={LOGO} width={40} height={40} />
        <tex
          source={`e^{i\\pi} + 1 = 0 \\qquad x^{${n}}`}
          size={26}
          displayMode
        />
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
          source={MARKDOWN}
          padding={16}
          onLink={(href) => console.log('link clicked:', href)}
        />
      </scrollview>
    </window>
  );
}

const root = await createRoot();
root.render(<App />);

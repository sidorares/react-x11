// The react-x11 errors an agent ran into, read from what its commands
// printed. Each is a rule AGENTS.md states, so a hit is a rule the context
// did not get across. Only the output of commands counts: an agent reading
// docs.md or AGENTS.md sees these words too, and that is not a trap hit.
import { toolResults } from './agents.mjs';

export const TRAPS = [
  // <box> at the root, a <window> inside a <box>
  { id: 'outside-window', re: /react-x11: <\w+> must be inside a <window>/ },
  // <box padding={8}>
  { id: 'flat-style-prop', re: /react-x11: <\w+ \w+=…> is a style property/ },
  // <box>hi</box>
  { id: 'raw-text', re: /react-x11: raw text .* must be (inside|wrapped in)/ },
  // <div>, <span>, <button>
  { id: 'unknown-element', re: /react-x11: unknown element type </ },
  // <box> inside <text>
  {
    id: 'element-in-text',
    re: /react-x11: <\w+> is not allowed inside <text>/,
  },
  // padding in a ':hover' block
  { id: 'state-block', re: /react-x11: "[^"]+" is not allowed inside ":/ },
  { id: 'unknown-style', re: /react-x11: unknown style property/ },
  { id: 'invalid-style', re: /react-x11: invalid \w+ / },
  // localStorage, document, window.* from web habits
  {
    id: 'dom-global',
    re: /ReferenceError: (localStorage|document|sessionStorage|HTMLElement) is not defined/,
  },
];

const COMMAND_TOOLS = new Set(['Bash', 'BashOutput', 'Monitor', 'KillShell']);

export function scanTraps(events) {
  const hits = Object.fromEntries(TRAPS.map((t) => [t.id, 0]));
  const samples = [];
  let anyReactX11Error = 0;
  for (const r of toolResults(events)) {
    if (r.tool && !COMMAND_TOOLS.has(r.tool)) continue;
    let matched = false;
    for (const trap of TRAPS) {
      const m = trap.re.exec(r.text);
      if (!m) continue;
      hits[trap.id]++;
      matched = true;
      if (samples.length < 12) {
        const line = r.text
          .slice(m.index, r.text.indexOf('\n', m.index) >>> 0)
          .slice(0, 200);
        samples.push({ trap: trap.id, text: line });
      }
    }
    if (matched || /react-x11: /.test(r.text))
      anyReactX11Error += /Error|throw|at /.test(r.text) ? 1 : 0;
  }
  const total = Object.values(hits).reduce((a, b) => a + b, 0);
  return { total, hits, samples, reactX11ErrorOutputs: anyReactX11Error };
}

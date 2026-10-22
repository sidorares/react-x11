// What the grader reads off the app's source without running it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { walk } from './common.mjs';

const SOURCE = /\.(jsx?|tsx?|mjs|cjs)$/;

/** Packages that need a DOM, or a CSS pipeline, and so cannot work here. */
export const WEB_PACKAGES = [
  /^react-dom(\/|$)/,
  /^tailwindcss(\/|$)/,
  /^@tailwindcss\//,
  /^@mui\//,
  /^@material-ui\//,
  /^@radix-ui\//,
  /^@chakra-ui\//,
  /^@mantine\//,
  /^@headlessui\//,
  /^antd(\/|$)/,
  /^styled-components(\/|$)/,
  /^@emotion\//,
  /^recharts(\/|$)/,
  /^framer-motion(\/|$)/,
  /^lucide-react(\/|$)/,
  /^react-bootstrap(\/|$)/,
  /^bootstrap(\/|$)/,
  /^electron(\/|$)/,
  /^@shadcn\//,
  /^next(\/|$)/,
];

const NAMED_COLOURS =
  'white|black|gray|grey|red|green|blue|yellow|orange|purple|pink|silver|navy|teal|' +
  'lightgray|lightgrey|darkgray|darkgrey|whitesmoke|gainsboro|crimson|tomato|gold';

/** Comments out, strings kept: a `//` inside 'https://…' is not a comment. */
function stripComments(src) {
  return src.replace(
    /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (m, str) => str ?? m.replace(/[^\n]/g, ' '),
  );
}

const lineOf = (src, index) => src.slice(0, index).split('\n').length;

/**
 * @param {string} app the app's directory
 * @returns the source facts the grader scores
 */
export function scanSource(app) {
  const files = walk(app).filter(
    (f) =>
      SOURCE.test(f) &&
      !/(^|\/)(test|tests|__tests__)\//.test(f) &&
      !/\.test\.|\.spec\./.test(f) &&
      !f.startsWith('.evals') &&
      // what the app runs: src/, and an entry beside package.json
      (f.startsWith('src/') || !f.includes('/')),
  );
  const out = {
    files: files.length,
    lines: 0,
    webImports: [],
    hexColours: [],
    namedColours: [],
    gradients: [],
    emoji: [],
    className: [],
    bigRadius: [],
    menuBar: false,
    minWidthInSource: false,
    componentsPackage: false,
  };
  const at = (file, src, index, text) => ({
    file,
    line: lineOf(src, index),
    text: text.slice(0, 80),
  });

  for (const file of files) {
    const raw = readFileSync(join(app, file), 'utf8');
    const src = stripComments(raw);
    out.lines += raw.split('\n').length;

    for (const m of src.matchAll(
      /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"]([^'"]+)['"]/g,
    )) {
      if (WEB_PACKAGES.some((re) => re.test(m[1])))
        out.webImports.push(at(file, src, m.index, m[1]));
      if (m[1].startsWith('@react-x11/components'))
        out.componentsPackage = true;
    }
    for (const m of src.matchAll(/(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g)) {
      const value = m[2];
      if (
        /(^|[\s(,])#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?![0-9a-zA-Z])/.test(
          value,
        ) ||
        /\b(rgba?|hsla?)\s*\(/.test(value)
      ) {
        out.hexColours.push(at(file, src, m.index, value));
      }
      if (/\p{Emoji_Presentation}|️/u.test(value))
        out.emoji.push(at(file, src, m.index, value));
      if (/(linear|radial|conic)-gradient\(/.test(value))
        out.gradients.push(at(file, src, m.index, value));
    }
    // JSX text is not in quotes
    for (const m of src.matchAll(
      />([^<>{}]*\p{Emoji_Presentation}[^<>{}]*)</gu,
    )) {
      out.emoji.push(at(file, src, m.index, m[1].trim()));
    }
    const named = new RegExp(
      `\\b(color|backgroundColor|borderColor|background|fill|stroke|outlineColor)\\s*:\\s*['"](${NAMED_COLOURS})['"]`,
      'gi',
    );
    for (const m of src.matchAll(named))
      out.namedColours.push(at(file, src, m.index, m[0]));
    for (const m of src.matchAll(/\bclassName\s*=/g))
      out.className.push(at(file, src, m.index, m[0]));
    for (const m of src.matchAll(/\bborderRadius\s*:\s*(\d+)/g)) {
      const r = Number(m[1]);
      // a pill or a circle (999, 50%) is a shape, not "everything rounded"
      if (r >= 16 && r < 100) out.bigRadius.push(at(file, src, m.index, m[0]));
    }
    if (/<MenuBar\b/.test(src)) out.menuBar = true;
    if (/<window\b[^>]*\bminWidth\s*=/.test(src)) out.minWidthInSource = true;
  }
  return out;
}

/** Dependencies the app declares that cannot work without a DOM. */
export function webDependencies(pkg) {
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  return Object.keys(deps).filter((d) => WEB_PACKAGES.some((re) => re.test(d)));
}

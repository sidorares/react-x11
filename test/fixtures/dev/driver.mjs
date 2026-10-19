// `react-x11 dev <file>` as the bin runs it, with the mock app where the
// display would be: test/cli-dev.test.js spawns this, edits the file under
// it, and reads stdout. `DEV …` lines are what the command printed;
// `devTree()` is the tree the app is in, for the fixtures' own RENDER lines.
// Nothing here imports the renderer before runDev has registered the hot
// loader — that order is the command's to keep, and the test is of it.
import { runDev } from '../../../src/cli/dev.js';

// `npm test` runs every module under test/, this one included, with no file
// to hand it; that run is not a session, and ends here.
if (process.argv[2] === undefined) process.exit(0);

let app = null;

function describe(node) {
  const label = node.isWindow ? `window(${node.props.title ?? ''})` : node.kind;
  const children = (node.children ?? []).map(describe);
  return children.length > 0 ? `${label}[${children.join(',')}]` : label;
}

globalThis.devTree = () =>
  ((app ?? globalThis.devApp)?._rootChildren ?? []).map(describe).join(' ') ||
  '(empty)';

await runDev(process.argv[2], {
  args: process.argv.slice(3),
  log: (line) => console.log(`DEV ${line}`),
  async createRoot(options) {
    const { createRoot } = await import('../../../src/index.js');
    const { createMockApp } = await import('../../../src/testing/mock-app.js');
    app = createMockApp();
    return createRoot({ app, ...options });
  },
});
console.log('READY');

// The mock app holds no socket, and the file watcher is deliberately not
// persistent; the test ends this process.
setInterval(() => {}, 60_000);

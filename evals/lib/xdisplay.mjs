// A display for an agent to open windows on that nobody sees: node-x11's
// pure-JavaScript X server (the one react-x11/test renders into), listening
// on the loopback. The agent's `npm start` then starts and stays up the way
// it would on a desktop, instead of failing to find one or opening a window
// over the person running the evals.
//
//   node xdisplay.mjs <dir whose node_modules has x11> [first display number]
//
// Prints DISPLAY=127.0.0.1:<n> once it listens; runs until killed.
import { createRequire } from 'node:module';
import { join } from 'node:path';

const [dir, first = '90'] = process.argv.slice(2);
const { XServer } = createRequire(join(dir, 'package.json'))(
  'x11/lib/xserver/index.js',
);

const server = new XServer({ width: 1920, height: 1200 });
let n = Number(first);
function attempt() {
  const srv = server.listen(n, '127.0.0.1', () => {
    process.stdout.write(`DISPLAY=127.0.0.1:${n}\n`);
  });
  srv.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && n < Number(first) + 200) {
      n++;
      attempt();
    } else {
      console.error(err.message);
      process.exit(1);
    }
  });
}
attempt();
process.on('SIGTERM', () => process.exit(0));

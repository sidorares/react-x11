#!/usr/bin/env node
// react-x11's command line, the `bin` of the package:
//
//   react-x11 dev <file> [args…]   hot reload with nothing to set up (./dev.js)
//   react-x11 help                 the usage, then every REACT_X11_* variable
//                                  the renderer reads (./env.js)
//
// Arguments before the file belong to the command, and everything after it
// to the app, which sees them in process.argv as `node <file> …args` would
// have handed them over.
import { readFileSync } from 'node:fs';
import { DevError, runDev } from './dev.js';
import { formatEnvironment } from './env.js';

const USAGE = `Usage: react-x11 dev <file> [args…]
       react-x11 help

Commands:
  dev <file>     Run <file> with hot reload: saving it, or a .jsx module it
                 imports, updates the running app in place. Its default
                 export is mounted, inside a window of its own when it
                 renders none; a file that mounts its own root runs as it is.
                 Arguments after the file are the app's.
                 Alt+Click (Option+Click on macOS) an element to open its
                 source; REACT_X11_CLICK_TO_COMPONENT=0 turns that off.
                 Connects to React DevTools (npx react-devtools) whenever
                 it runs; REACT_X11_DEVTOOLS=0 turns that off.
  help           Show this help, then every REACT_X11_* environment
                 variable the renderer reads, with what it does.

Options:
  -h, --help     Show this help.
  -v, --version  Print react-x11's version.
`;

function version() {
  const manifest = new URL('../../package.json', import.meta.url);
  return JSON.parse(readFileSync(manifest, 'utf8')).version;
}

/** An exit code to finish with, or undefined while the app runs. */
async function main([command, ...rest]) {
  if (command === '-h' || command === '--help') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command === 'help') {
    // A terminal's own width, within reason; 80 for a pipe or a file.
    const columns = process.stdout.isTTY ? process.stdout.columns : 80;
    const width = Math.min(100, Math.max(60, columns || 80));
    process.stdout.write(`${USAGE}\n${formatEnvironment(width)}`);
    return 0;
  }
  if (command === '-v' || command === '--version') {
    process.stdout.write(`${version()}\n`);
    return 0;
  }
  if (command === undefined) {
    process.stderr.write(USAGE);
    return 2;
  }
  if (command !== 'dev') {
    process.stderr.write(`react-x11: no command "${command}".\n\n${USAGE}`);
    return 2;
  }
  const at = rest.findIndex((arg) => !arg.startsWith('-'));
  const own = at === -1 ? rest : rest.slice(0, at);
  if (own.includes('-h') || own.includes('--help')) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (own.length > 0) {
    process.stderr.write(
      `react-x11 dev: no option ${own[0]} — options after the file are ` +
        `the app's.\n\n${USAGE}`,
    );
    return 2;
  }
  if (at === -1) {
    process.stderr.write(`react-x11 dev: which file?\n\n${USAGE}`);
    return 2;
  }
  await runDev(rest[at], { args: rest.slice(at + 1) });
  return undefined;
}

try {
  const code = await main(process.argv.slice(2));
  if (code !== undefined) process.exitCode = code;
} catch (err) {
  // A DevError is a sentence about the setup, and its stack is ours; any
  // other throw came out of the app's own module, and its stack is the
  // useful part.
  console.error(
    err instanceof DevError ? `react-x11 dev: ${err.message}` : err,
  );
  process.exitCode = 1;
}

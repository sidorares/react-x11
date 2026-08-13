#!/usr/bin/env node
// A man-in-the-middle for the React DevTools bridge.
//
// The bridge is not CDP and not a binary protocol: the backend
// (react-devtools-core, running inside the app) opens a plain WebSocket to
// the standalone DevTools app and both ends exchange text frames of
//
//     {"event": "<name>", "payload": <json>}
//
// This script sits in the middle of that socket. It listens where the
// backend expects DevTools, forwards every frame verbatim to the real
// DevTools, and prints what goes past — including the packed `operations`
// arrays, which are decoded here the way DevTools' own
// `printOperationsArray` decodes them.
//
//   node scripts/devtools-proxy.mjs                      # :8098 -> :8097
//   node scripts/devtools-proxy.mjs --listen 9000 --upstream box:8097
//   node scripts/devtools-proxy.mjs --only operations,inspectElement
//   node scripts/devtools-proxy.mjs --full --jsonl /tmp/bridge.jsonl
//
// Then start the app against the proxy port:
//   REACT_X11_DEVTOOLS=1 REACT_X11_DEVTOOLS_PORT=8098 node app.js
//
// See docs/devtools.md.

import { createWriteStream } from 'node:fs';
import { WebSocketServer, WebSocket } from 'ws';

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    listen: 8098,
    upstreamHost: 'localhost',
    upstreamPort: 8097,
    only: null,
    skip: null,
    full: false,
    jsonl: null,
    maxLength: 240,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '--listen':
      case '-l':
        opts.listen = Number(next());
        break;
      case '--upstream':
      case '-u': {
        const [host, port] = String(next()).split(':');
        opts.upstreamHost = host || 'localhost';
        opts.upstreamPort = Number(port) || 8097;
        break;
      }
      case '--only':
        opts.only = new Set(String(next()).split(','));
        break;
      case '--skip':
        opts.skip = new Set(String(next()).split(','));
        break;
      case '--full':
        opts.full = true;
        break;
      case '--max':
        opts.maxLength = Number(next());
        break;
      case '--jsonl':
        opts.jsonl = String(next());
        break;
      case '--help':
      case '-h':
        console.log(
          [
            'usage: node scripts/devtools-proxy.mjs [options]',
            '',
            '  -l, --listen PORT        port the app connects to (default 8098)',
            '  -u, --upstream HOST:PORT real DevTools (default localhost:8097)',
            '      --only a,b           print only these events',
            '      --skip a,b           print everything but these events',
            '      --full               print whole payloads, not a summary',
            '      --max N              summary length, in chars (default 240)',
            '      --jsonl FILE         also append every frame as JSON lines',
          ].join('\n'),
        );
        process.exit(0);
        break;
      default:
        console.error(`devtools-proxy: unknown option ${arg}`);
        process.exit(1);
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

// ---------------------------------------------------------------------------
// The operations array
// ---------------------------------------------------------------------------
//
// A tree delta, packed into one flat array of numbers so a commit costs one
// small frame: [rendererID, rootID, stringTableLength, ...stringTable,
// ...operations]. Ported from react-devtools-shared's printOperationsArray
// (react-devtools-core 7); if a future version adds an opcode, decoding
// stops at it rather than lying about the rest.

const TREE_OPERATION_ADD = 1;
const TREE_OPERATION_REMOVE = 2;
const TREE_OPERATION_REORDER_CHILDREN = 3;
const TREE_OPERATION_UPDATE_TREE_BASE_DURATION = 4;
const TREE_OPERATION_UPDATE_ERRORS_OR_WARNINGS = 5;
const TREE_OPERATION_REMOVE_ROOT = 6;
const TREE_OPERATION_SET_SUBTREE_MODE = 7;
const SUSPENSE_TREE_OPERATION_ADD = 8;
const SUSPENSE_TREE_OPERATION_REMOVE = 9;
const SUSPENSE_TREE_OPERATION_REORDER_CHILDREN = 10;
const SUSPENSE_TREE_OPERATION_RESIZE = 11;
const SUSPENSE_TREE_OPERATION_SUSPENDERS = 12;

const ELEMENT_TYPE_ROOT = 11;
const ELEMENT_TYPE_NAMES = {
  1: 'Class',
  2: 'Context',
  5: 'Function',
  6: 'ForwardRef',
  7: 'Host',
  8: 'Memo',
  9: 'Other',
  10: 'Profiler',
  11: 'Root',
  12: 'Suspense',
  13: 'SuspenseList',
  14: 'TracingMarker',
  15: 'Virtual',
  16: 'ViewTransition',
  17: 'Activity',
};

function decodeString(array, left, right) {
  let string = '';
  for (let i = left; i <= right; i++) string += String.fromCodePoint(array[i]);
  return string;
}

function decodeOperations(operations) {
  const logs = [];
  const rendererID = operations[0];
  const rootID = operations[1];
  logs.push(`renderer ${rendererID}, root ${rootID}`);

  let i = 2;
  const stringTable = [null];
  const stringTableEnd = i + 1 + operations[i];
  i++;
  while (i < stringTableEnd) {
    const length = operations[i++];
    stringTable.push(decodeString(operations, i, i + length - 1));
    i += length;
  }

  while (i < operations.length) {
    const op = operations[i];
    switch (op) {
      case TREE_OPERATION_ADD: {
        const id = operations[i + 1];
        const type = operations[i + 2];
        i += 3;
        if (type === ELEMENT_TYPE_ROOT) {
          i += 4; // isStrictMode, profilingFlags, supportsStrictMode, hasOwnerMetadata
          logs.push(`add root ${id}`);
        } else {
          const parentID = operations[i];
          i += 2; // parentID, ownerID
          const displayName = stringTable[operations[i]];
          i += 3; // displayName, key, env
          const kind = ELEMENT_TYPE_NAMES[type] ?? type;
          logs.push(
            `add ${id} <${displayName ?? 'null'}> (${kind}) under ${parentID}`,
          );
        }
        break;
      }
      case TREE_OPERATION_REMOVE: {
        const count = operations[i + 1];
        i += 2;
        const ids = operations.slice(i, i + count);
        i += count;
        logs.push(`remove ${ids.join(', ')}`);
        break;
      }
      case TREE_OPERATION_REMOVE_ROOT:
        i += 1;
        logs.push(`remove root ${rootID}`);
        break;
      case TREE_OPERATION_SET_SUBTREE_MODE: {
        logs.push(`subtree mode ${operations[i + 2]} for ${operations[i + 1]}`);
        i += 3;
        break;
      }
      case TREE_OPERATION_REORDER_CHILDREN: {
        const id = operations[i + 1];
        const count = operations[i + 2];
        i += 3;
        const children = operations.slice(i, i + count);
        i += count;
        logs.push(`reorder ${id} children ${children.join(', ')}`);
        break;
      }
      case TREE_OPERATION_UPDATE_TREE_BASE_DURATION:
        // [id, duration] — profiler bookkeeping, noise in a trace
        i += 3;
        break;
      case TREE_OPERATION_UPDATE_ERRORS_OR_WARNINGS: {
        logs.push(
          `node ${operations[i + 1]}: ${operations[i + 2]} errors, ` +
            `${operations[i + 3]} warnings`,
        );
        i += 4;
        break;
      }
      case SUSPENSE_TREE_OPERATION_ADD: {
        const id = operations[i + 1];
        const parentID = operations[i + 2];
        const name = stringTable[operations[i + 3]];
        const isSuspended = operations[i + 4];
        const numRects = operations[i + 5];
        i += 6;
        if (numRects !== -1) i += numRects * 4;
        logs.push(
          `add suspense ${id} <${name ?? 'null'}> under ${parentID}` +
            (isSuspended ? ' (suspended)' : ''),
        );
        break;
      }
      case SUSPENSE_TREE_OPERATION_REMOVE: {
        const count = operations[i + 1];
        i += 2;
        const ids = operations.slice(i, i + count);
        i += count;
        logs.push(`remove suspense ${ids.join(', ')}`);
        break;
      }
      case SUSPENSE_TREE_OPERATION_REORDER_CHILDREN: {
        const id = operations[i + 1];
        const count = operations[i + 2];
        i += 3 + count;
        logs.push(`reorder suspense ${id}`);
        break;
      }
      case SUSPENSE_TREE_OPERATION_RESIZE: {
        const id = operations[i + 1];
        const numRects = operations[i + 2];
        i += 3;
        if (numRects !== -1) i += numRects * 4;
        logs.push(`resize suspense ${id}`);
        break;
      }
      case SUSPENSE_TREE_OPERATION_SUSPENDERS: {
        i += 1;
        const count = operations[i++];
        for (let c = 0; c < count; c++) {
          const id = operations[i];
          i += 3;
          i += operations[i] + 1; // environment names
          logs.push(`suspenders changed for ${id}`);
        }
        break;
      }
      default:
        logs.push(`(unknown opcode ${op} at ${i} — stopping)`);
        i = operations.length;
    }
  }
  return logs;
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

const color = process.stdout.isTTY
  ? {
      dim: (s) => `\x1b[2m${s}\x1b[0m`,
      up: (s) => `\x1b[36m${s}\x1b[0m`, // app -> devtools
      down: (s) => `\x1b[35m${s}\x1b[0m`, // devtools -> app
      bold: (s) => `\x1b[1m${s}\x1b[0m`,
      red: (s) => `\x1b[31m${s}\x1b[0m`,
    }
  : {
      dim: (s) => s,
      up: (s) => s,
      down: (s) => s,
      bold: (s) => s,
      red: (s) => s,
    };

const started = Date.now();
const stamp = () => ((Date.now() - started) / 1000).toFixed(3).padStart(8);

function summarize(payload) {
  let text;
  try {
    text = JSON.stringify(payload);
  } catch {
    text = String(payload);
  }
  if (text === undefined) return '';
  if (opts.full || text.length <= opts.maxLength) return text;
  return `${text.slice(0, opts.maxLength)}… (${text.length} chars)`;
}

const jsonl = opts.jsonl ? createWriteStream(opts.jsonl, { flags: 'a' }) : null;

function logFrame(direction, raw) {
  let frame;
  try {
    frame = JSON.parse(raw);
  } catch {
    console.log(
      `${color.dim(stamp())} ${direction} ${color.red('(non-JSON frame)')} ${raw.slice(0, 120)}`,
    );
    return;
  }
  const { event, payload } = frame;
  jsonl?.write(
    JSON.stringify({ t: Date.now() - started, direction, event, payload }) +
      '\n',
  );
  if (opts.only && !opts.only.has(event)) return;
  if (opts.skip?.has(event)) return;

  const arrow =
    direction === 'app→devtools' ? color.up('▲ app') : color.down('▼ devtools');
  const size = `${raw.length}B`;

  if (event === 'operations' && Array.isArray(payload)) {
    const lines = decodeOperations(payload);
    console.log(
      `${color.dim(stamp())} ${arrow} ${color.bold(event)} ${color.dim(size)}`,
    );
    for (const line of lines) console.log(`         ${color.dim('·')} ${line}`);
    if (opts.full)
      console.log(`         ${color.dim(JSON.stringify(payload))}`);
    return;
  }

  console.log(
    `${color.dim(stamp())} ${arrow} ${color.bold(event)} ${color.dim(size)} ${summarize(payload)}`,
  );
}

// ---------------------------------------------------------------------------
// The proxy
// ---------------------------------------------------------------------------

const upstreamURL = `ws://${opts.upstreamHost}:${opts.upstreamPort}`;
const server = new WebSocketServer({ port: opts.listen });
let connections = 0;

server.on('listening', () => {
  console.log(
    color.bold(
      `devtools-proxy: listening on ws://localhost:${opts.listen} → ${upstreamURL}`,
    ),
  );
  console.log(
    color.dim(
      `  run the app with REACT_X11_DEVTOOLS=1 REACT_X11_DEVTOOLS_PORT=${opts.listen}`,
    ),
  );
});

server.on('error', (err) => {
  console.error(color.red(`devtools-proxy: ${err.message}`));
  process.exit(1);
});

server.on('connection', (client, req) => {
  const id = ++connections;
  const from = req.socket.remoteAddress;
  console.log(color.bold(`\n── #${id} app connected (${from}) ──`));

  const upstream = new WebSocket(upstreamURL);
  // Frames the app sends before DevTools' socket is open: the backend does
  // not wait, and dropping them would cost the initial tree.
  const pending = [];

  upstream.on('open', () => {
    console.log(color.dim(`   #${id} upstream ${upstreamURL} open`));
    for (const raw of pending) upstream.send(raw);
    pending.length = 0;
  });

  upstream.on('message', (data) => {
    const raw = data.toString();
    logFrame('devtools→app', raw);
    if (client.readyState === WebSocket.OPEN) client.send(raw);
  });

  client.on('message', (data) => {
    const raw = data.toString();
    logFrame('app→devtools', raw);
    if (upstream.readyState === WebSocket.OPEN) upstream.send(raw);
    else pending.push(raw);
  });

  const closeBoth = (who) => () => {
    console.log(color.dim(`   #${id} ${who} closed`));
    if (client.readyState === WebSocket.OPEN) client.close();
    if (upstream.readyState <= WebSocket.OPEN) upstream.close();
  };
  client.on('close', closeBoth('app'));
  upstream.on('close', closeBoth('devtools'));

  upstream.on('error', (err) => {
    // The backend retries on its own, so failing loudly and hanging up is
    // the useful behaviour: start the standalone app and it reconnects.
    console.error(
      color.red(`   #${id} upstream error: ${err.message} — is DevTools up?`),
    );
    if (client.readyState === WebSocket.OPEN) client.close();
  });
  client.on('error', (err) => {
    console.error(color.red(`   #${id} app error: ${err.message}`));
  });
});

process.on('SIGINT', () => {
  console.log('\ndevtools-proxy: bye');
  jsonl?.end();
  server.close(() => process.exit(0));
});

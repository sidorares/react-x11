// The DevTools frontend, near enough: a socket that records what the app
// says and can say things back. The bridge batches, so everything here
// waits for an event rather than assuming it has arrived.
import { WebSocketServer } from 'ws';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function fakeDevTools() {
  const server = new WebSocketServer({ port: 0 });
  await new Promise((resolve) => server.on('listening', resolve));
  const received = [];
  let socket = null;
  const connected = new Promise((resolve) => {
    server.on('connection', (ws) => {
      socket = ws;
      ws.on('message', (data) => received.push(JSON.parse(data.toString())));
      resolve(ws);
    });
  });
  return {
    port: server.address().port,
    connected,
    received,
    send: (event, payload) => socket.send(JSON.stringify({ event, payload })),
    async waitFor(event, timeout = 5000) {
      const deadline = Date.now() + timeout;
      for (;;) {
        const hit = received.find((m) => m.event === event);
        if (hit) return hit;
        if (Date.now() > deadline) {
          throw new Error(
            `timed out waiting for "${event}"; saw ` +
              [...new Set(received.map((m) => m.event))].join(', '),
          );
        }
        await sleep(20);
      }
    },
    async close() {
      socket?.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** A backend whose socket closes reconnects forever (handleClose ->
 * scheduleRetry), which is what an app wants and what would keep a test
 * process alive after the last assertion. Unref every timer from here on,
 * so the retries continue without being a reason to stay up. */
export function unrefFurtherTimers() {
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms, ...rest) => {
    const timer = realSetTimeout(fn, ms, ...rest);
    timer.unref?.();
    return timer;
  };
}

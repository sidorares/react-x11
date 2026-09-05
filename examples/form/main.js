// The entry `bun build --compile` turns into Guestbook.app's executable
// (make-app.sh). Everything JavaScript is inside the binary; the one thing
// that cannot be is the Cocoa bridge's native addon, which the backend loads
// by `require` from a path. The bundle carries it in Contents/Resources, and
// this names it before the backend goes looking — relative to the running
// executable, which is Contents/MacOS/Guestbook wherever the bundle lives.
import path from 'node:path';

const contents = path.resolve(path.dirname(process.execPath), '..');
process.env.REACT_X11_CALAYERS_PATH ??= path.join(
  contents,
  'Resources',
  'calayers.node',
);
process.env.REACT_X11_BACKEND ??= 'cocoa';

await import('./index.jsx');

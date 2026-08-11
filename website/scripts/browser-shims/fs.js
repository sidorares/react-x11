// Browser stub for node's `fs`. Three callers: x11's lib/auth.js (reading
// ~/.Xauthority, and custom transports skip auth entirely), react-x11's
// remembered system appearance, and the Compose file `compose: 'system'`
// looks for — which finds none here, so composition falls back to its
// built-in table, which is the whole table a browser was ever going to get.
// Keep the shape callable so any stray call
// fails softly through the normal error path — both of those already treat a
// throw as "no cached value", which in a browser is the truth.
const noFilesystem = (what) => {
  const err = new Error(`ENOENT: no file system in the browser (${what})`);
  err.code = 'ENOENT';
  return err;
};

module.exports = {
  readFile(path, cb) {
    const err = noFilesystem(path);
    if (typeof cb === 'function') queueMicrotask(() => cb(err));
  },
  readFileSync(path) {
    throw noFilesystem(path);
  },
  writeFileSync(path) {
    throw noFilesystem(path);
  },
  mkdirSync(path) {
    throw noFilesystem(path);
  },
  renameSync(path) {
    throw noFilesystem(path);
  },
  unlinkSync(path) {
    throw noFilesystem(path);
  },
  existsSync() {
    return false;
  },
};

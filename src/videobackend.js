// Who writes a `<video>`'s frames natively on an app, if anyone — the seam
// `VideoFrames.preferredFormats` and the drawn presentation ask through
// (design/architecture/video.md §6.3).
//
// The app itself where its backend has the verbs: the Cocoa app over the
// bridge's video surfaces, the Wayland app over its own GL context. On X11
// the app is ntk's, which knows nothing of sinks, so the answer is the Xv
// writer react-x11 keeps for the connection (src/xvideo.js). A feature test,
// not a question about which backend this is — `typeof app.xv` is an ntk
// with XVideo discovery. Null where nothing will, and every frame is
// converted in JavaScript (`frameToRGBA`, src/videoframes.js).
import { xvVideoFor } from './xvideo.js';

/**
 * `{ videoFormats(), writeVideoFrame(surface, sink, frame, node),
 * releaseVideoFrame?(surface), prepare?(sink) }` for `app`, or null.
 */
export function videoBackendOf(app) {
  if (!app) return null;
  if (
    typeof app.writeVideoFrame === 'function' ||
    typeof app.videoFormats === 'function'
  ) {
    return app;
  }
  if (typeof app.xv === 'function') return xvVideoFor(app);
  return null;
}

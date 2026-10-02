// `useVideoFrames`: a VideoFrames sink for a component (src/videoframes.js).
import { useMemo } from 'react';

import { useApp } from './appcontext.js';
import { createVideoFrames } from './videoframes.js';

/**
 * A sink for decoded frames of one size and format, the same object across
 * renders and a new one when the size, the format or the colour changes —
 * so a decoder started in an effect keyed on it is restarted exactly when
 * its output would no longer fit:
 *
 * ```jsx
 * const frames = useVideoFrames({ width: 1280, height: 720, format: 'NV12' });
 * useEffect(() => startDecoder(url, frames), [frames, url]);
 * <video frames={frames} style={{ width: '100%', aspectRatio: 16 / 9 }} />;
 * ```
 *
 * Nothing to close on unmount: a sink owns nothing native, and what shows
 * it lets go of what it made when it stops showing it.
 */
export function useVideoFrames(options) {
  const app = useApp();
  const { width, height, format, colorSpace, range } = options ?? {};
  return useMemo(
    () => createVideoFrames(app, { width, height, format, colorSpace, range }),
    [app, width, height, format, colorSpace, range],
  );
}

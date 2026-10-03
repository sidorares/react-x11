// The pane the pane-player tests mount: one `<video src>`, what it hears
// sent back through bridged callbacks as plain data, and a `command` prop
// that drives its ref — `{ n, op, arg }`, run once per `n`.
import React, { useEffect, useRef } from 'react';

import { useSupports } from '../../src/index.js';

const h = React.createElement;

export default function VideoPane({
  src = '/tmp/clip.mp4',
  autoPlay,
  show = true,
  command,
  onSupports,
  onMeta,
  onPlay,
  onPause,
  onTime,
  onError,
}) {
  const playback = useSupports('mediaPlayback');
  const video = useRef(null);
  useEffect(() => {
    onSupports?.(playback);
  }, [playback]);
  useEffect(() => {
    if (command) video.current?.[command.op](command.arg);
  }, [command?.n]);
  return h(
    'box',
    { style: { paddingLeft: 10, paddingTop: 10 } },
    show &&
      h('video', {
        ref: video,
        src,
        autoPlay,
        style: { width: 160, height: 90 },
        onLoadedMetadata: (e) =>
          onMeta?.({ width: e.width, height: e.height, duration: e.duration }),
        onPlay: () => onPlay?.(),
        onPause: () => onPause?.(),
        onTimeUpdate: (e) => onTime?.(e.currentTime),
        onError: (err) => onError?.(err.name),
      }),
  );
}

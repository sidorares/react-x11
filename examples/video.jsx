// A video file — or ffmpeg's test pattern — decoded by an `ffmpeg` child
// process into a `<video frames>` sink, with a caption drawn over the
// picture: it is in the paint order like anything else, so the caption is
// simply a box after it.
//
// Run with: npm run examples:video [-- path/to/clip.mp4]
// Needs `ffmpeg` and `ffprobe` on the PATH. Silent: a sink is frames, not
// sound (docs/elements.md#video). The decoder is asked for the display's
// cheapest format — NV12 through an Xv port on X11 or a shader on Wayland,
// BGRA where every frame is converted in JavaScript.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import React, { useEffect, useState } from 'react';

import {
  createRoot,
  createVideoFrames,
  useApp,
  useVideoFrames,
} from '../src/index.js';

const PIX_FMT = { NV12: 'nv12', I420: 'yuv420p', BGRA: 'bgra' };
const BYTES = { NV12: 1.5, I420: 1.5, BGRA: 4 };

/** The input's ffmpeg arguments: the file, looped, or the test pattern. */
const inputOf = (file) =>
  file
    ? ['-stream_loop', '-1', '-i', file]
    : ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30'];

/** The clip's size and colour, from ffprobe. */
async function probe(file) {
  const { stdout } = await promisify(execFile)('ffprobe', [
    ...['-v', 'error', '-select_streams', 'v:0', '-of', 'json'],
    ...['-show_entries', 'stream=width,height,color_space,color_range'],
    ...(file ? [file] : ['-f', 'lavfi', 'testsrc2=size=640x360']),
  ]);
  const s = JSON.parse(stdout).streams[0];
  const sd = s.color_space === 'bt470bg' || s.color_space === 'smpte170m';
  return {
    width: s.width,
    height: s.height,
    colorSpace: sd ? 'bt601' : 'bt709',
    range: s.color_range === 'pc' ? 'full' : 'video',
  };
}

function Player({ file, clip }) {
  const frames = useVideoFrames(clip);
  useEffect(() => {
    const ffmpeg = spawn(
      'ffmpeg',
      [
        ...['-v', 'error', '-re', ...inputOf(file), '-an'],
        ...['-vf', `scale=out_color_matrix=${clip.colorSpace}`],
        ...['-pix_fmt', PIX_FMT[clip.format], '-f', 'rawvideo', 'pipe:1'],
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    // one frame per `size` bytes of the pipe, however it is chunked
    const size = clip.width * clip.height * BYTES[clip.format];
    let buffered = Buffer.alloc(0);
    ffmpeg.stdout.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= size) {
        frames.push(buffered.subarray(0, size));
        buffered = buffered.subarray(size);
      }
    });
    return () => ffmpeg.kill();
  }, [frames, file, clip]);
  return (
    <box style={{ flexGrow: 1, padding: 12 }}>
      <video
        frames={frames}
        style={{ flexGrow: 1, objectFit: 'contain', backgroundColor: '#000' }}
      />
      <box
        style={{
          position: 'absolute',
          left: 24,
          bottom: 24,
          padding: 8,
          borderRadius: 6,
          backgroundColor: '#000000aa',
        }}
      >
        <text style={{ color: '#ffffff' }}>
          {file ?? 'testsrc2'} · {clip.width}x{clip.height} {clip.format}
        </text>
      </box>
    </box>
  );
}

export default function App({ file = process.argv[2] }) {
  const app = useApp();
  const [clip, setClip] = useState(null);
  useEffect(() => {
    // A sink asked for its formats starts the display answering — on X11 an
    // Xv port, a few round trips — while ffprobe reads the clip.
    const asking = createVideoFrames(app, { width: 2, height: 2 });
    let live = true;
    probe(file).then((found) => {
      if (live) setClip({ ...found, format: asking.preferredFormats[0] });
    });
    return () => {
      live = false;
    };
  }, [app, file]);
  return (
    <window
      width={720}
      height={460}
      title="video"
      style={{ backgroundColor: '$surface' }}
    >
      {clip && <Player file={file} clip={clip} />}
    </window>
  );
}

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<App />);
}

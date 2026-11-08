// The pane the pane-capture tests mount: a camera, a microphone or both
// through `useUserMedia` — or the screen through `useDisplayMedia`, with
// `share` — the picture shown in a `<video srcObject>`, and
// what it hears sent back through bridged callbacks as plain data — the
// capability, the devices, the session's status, the frames its tracks hand
// a reader (`frames`), a sink's clock after a push (`play: { n, samples }`)
// and a screenshot (`shoot`, one per new number).
import React, { useEffect, useRef } from 'react';

import {
  captureScreenshot,
  createAudioFrames,
  useApp,
  useDesktopCapability,
  useDisplayMedia,
  useMediaDevices,
  useUserMedia,
} from '../../src/index.js';

const h = React.createElement;

export default function CapturePane({
  video = false,
  audio = false,
  share = false,
  show = true,
  frames = false,
  play = null,
  shoot = 0,
  onCapability,
  onDevices,
  onStatus,
  onFrame,
  onClock,
  onShot,
  onError,
}) {
  const app = useApp();
  const camera = useDesktopCapability('camera');
  const output = useDesktopCapability('audioOutput');
  const { devices, settled } = useMediaDevices();
  const call = useUserMedia(
    { video, audio },
    { start: Boolean(video || audio) },
  );
  const screen = useDisplayMedia(
    { video: { width: 640, frameRate: 15 } },
    { start: share },
  );
  const shown = share ? screen : call;
  const sink = useRef(null);

  useEffect(() => {
    onCapability?.({
      camera: camera.available,
      backend: camera.backend,
      nativePreview: camera.features?.nativePreview ?? null,
      audioOutput: output.available,
    });
  }, [camera.available, output.available]);

  useEffect(() => {
    if (settled) {
      onDevices?.(devices.map((d) => ({ kind: d.kind, label: d.label })));
    }
  }, [settled, devices]);

  useEffect(() => {
    onStatus?.({
      status: shown.status,
      error: shown.error?.name ?? null,
      settings:
        shown.stream?.getTracks().map((t) => ({
          kind: t.kind,
          ...t.getSettings(),
        })) ?? [],
    });
  }, [shown.status]);

  useEffect(() => {
    if (!frames || !shown.stream) return undefined;
    const offs = shown.stream.getTracks().map((track) =>
      track.onFrame((f) =>
        onFrame?.(
          track.kind === 'video'
            ? {
                kind: 'video',
                format: f.format,
                width: f.width,
                height: f.height,
                first: f.planes[0][0],
              }
            : {
                kind: 'audio',
                frames: f.frames,
                sampleRate: f.sampleRate,
                first: f.channels[0][0],
              },
        ),
      ),
    );
    return () => offs.forEach((off) => off());
  }, [frames, shown.stream]);

  useEffect(() => {
    if (!play) return;
    sink.current ??= createAudioFrames(app, { sampleRate: 48000, channels: 1 });
    sink.current.push([Float32Array.from(play.samples)]);
    onClock?.({ queued: sink.current.queued });
  }, [play?.n]);
  useEffect(() => () => sink.current?.close(), []);

  useEffect(() => {
    if (!shoot) return;
    captureScreenshot({ app }).then(
      (shot) =>
        onShot?.({
          width: shot.width,
          height: shot.height,
          first: shot.data[0],
        }),
      (err) => onError?.(err.name),
    );
  }, [shoot]);

  return h(
    'box',
    { style: { paddingLeft: 10, paddingTop: 10 } },
    show &&
      shown.stream?.getVideoTracks().length > 0 &&
      h('video', {
        srcObject: shown.stream,
        style: { width: 160, height: 90 },
      }),
  );
}

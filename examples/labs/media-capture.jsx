// Media capture: the manual rig for everything docs/media.md describes —
// what the display says it can do, the permissions, the devices as they
// are plugged in and out, a camera, a microphone with a level meter, the
// audio out, screenshots and screen sharing, and other applications'
// sound — in one window, with a log of what each step answered.
//
// A lab rather than a tour example (AGENTS.md, "Writing an example"): it is
// not a program anybody keeps running, it is the harness for what CI cannot
// check — a real camera, a real microphone, the system's prompts.
//
//   npm run labs:media-capture
//   npm run labs:media-capture -- --pane
//
// `--pane` runs the same lab in a `<Frame>` pane, in a process of its own,
// whose capture its host does (docs/frame.md): the camera opened and shown
// through the host, the microphone's chunks and the tone's samples crossing
// the pane's channel. The window's own rows (this window, keeping it out of
// captures) are the host's, and a pane has none.
//
// On macOS it runs on the Cocoa backend (@windowkit/appkit 0.32 or later);
// `REACT_X11_BACKEND=x11` puts it on XQuartz, where only the screen half
// answers. Things worth trying:
//
//   - **Camera**: start it, switch the size while it runs, untick
//     "enabled", tick "read frames" to see what crosses into JavaScript.
//     Unplug a USB camera while it runs: the status says `ended`.
//   - **Microphone**: start it and watch the meter; untick echo
//     cancellation and see what `echoCancellation` the track reports;
//     16 kHz is what a speech model wants. "Hear yourself" plays the
//     microphone back — use headphones.
//   - **Echo**: with the microphone on and echo cancellation ticked, play
//     the tone through the speakers. The meter should barely move; with it
//     unticked, it should jump.
//   - **Screen**: a screenshot of the display, of this window, of a part of
//     the display; tick "keep this window out of captures" and take the
//     window again. Saved to the temp directory, path in the log.
//   - **System audio** (macOS 14.2): record "System audio" and play
//     something in another app — the meter moves; play this lab's own tone
//     instead and it should not, since this app is left out. Pick one
//     application to hear only it; a browser plays through helper processes,
//     which its entry takes in. "Save WAV" writes what was recorded, at the
//     rate and channels asked, for listening to.
//
// macOS asks for the camera, the microphone, Screen Recording and System
// Audio Recording the first time each is used — on behalf of whichever app
// started node (the terminal, an editor), which for system audio needs
// NSAudioCaptureUsageDescription. A refusal without a prompt is the packaging
// trap docs/packaging.md describes, and the log says which it was.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import {
  Button,
  Checkbox,
  Frame,
  Select,
  captureScreenshot,
  createAudioFrames,
  createRoot,
  createStyles,
  displaySources,
  isFramed,
  useApp,
  useDesktopCapability,
  useDisplayMedia,
  useMediaDevices,
  usePermission,
  useUserMedia,
} from '../../src/index.js';

const s = createStyles({
  root: { flexDirection: 'column', padding: 12, gap: 10, flexGrow: 1 },
  // the columns scroll when a screen is shorter than they are, so a section
  // never hides under the log
  scroll: { flexGrow: 1, minHeight: 0, overflow: 'scroll' },
  columns: { flexDirection: 'row', gap: 10 },
  column: { flexDirection: 'column', gap: 10, flexBasis: 0, flexGrow: 1 },
  section: {
    flexDirection: 'column',
    gap: 6,
    padding: 10,
    backgroundColor: '$surface',
    borderColor: '$track',
    borderWidth: 1,
    borderRadius: 6,
  },
  title: { color: '$text', fontSize: 13, fontWeight: 'bold' },
  row: { flexDirection: 'row', gap: 6, alignItems: 'center', flexWrap: 'wrap' },
  text: { color: '$text', fontSize: 12 },
  dim: { color: '$textMuted', fontSize: 11 },
  picture: {
    width: 320,
    height: 180,
    backgroundColor: '#000000',
    objectFit: 'contain',
    borderRadius: 4,
  },
  // a row, so the fill takes the meter's height and its own share of width
  meter: {
    flexDirection: 'row',
    height: 10,
    flexGrow: 1,
    backgroundColor: '$track',
    borderRadius: 5,
    overflow: 'hidden',
  },
  log: {
    flexDirection: 'column',
    padding: 8,
    height: 140,
    overflow: 'scroll',
    backgroundColor: '$surface',
    borderColor: '$track',
    borderWidth: 1,
    borderRadius: 6,
  },
});

const DEFAULT = '';
const valueOf = (ev) => ev.value ?? ev.target?.value;
const checkedOf = (ev) => ev.target.checked;

function Section({ title, children }) {
  return (
    <box style={s.section}>
      <text style={s.title}>{title}</text>
      {children}
    </box>
  );
}

/** A request's status as it moves, and its error, into the log. */
function useStatusLog(what, request, log) {
  useEffect(() => {
    const e = request.error;
    log(`${what}: ${request.status}${e ? ` — ${e.name}: ${e.message}` : ''}`);
  }, [what, request.status, request.error, log]);
}

/** A render whenever the track's state moves: muted, ended, settings. */
function useTrack(stream, kind) {
  const track =
    (kind === 'video'
      ? stream?.getVideoTracks()
      : stream?.getAudioTracks())?.[0] ?? null;
  const [, setTick] = useState(0);
  useEffect(() => track?.onChange(() => setTick((n) => n + 1)), [track]);
  return track;
}

const deviceOptions = (devices) => [
  { value: DEFAULT, label: 'Default' },
  ...devices.map((d) => ({
    value: d.deviceId,
    label: `${d.label || d.deviceId}${d.isDefault ? ' (default)' : ''}`,
  })),
];

const settingsLine = (track) => {
  if (!track) return 'no track';
  const { deviceId, groupId, ...rest } = track.getSettings();
  void deviceId;
  void groupId;
  const parts = Object.entries(rest).map(
    ([k, v]) => `${k}=${typeof v === 'number' ? +v.toFixed(2) : v}`,
  );
  return `${track.readyState}${track.muted ? ', muted' : ''}: ${parts.join(' ')}`;
};

// --- what the display can do -----------------------------------------------

/** The @windowkit/appkit this process loads on macOS — REACT_X11_CALAYERS_PATH
 *  first, as src/cocoa/native.js resolves it — or null off the Cocoa
 *  backend. A lab's question: an install older than 0.31 answers every
 *  capture capability unavailable, and one older than 0.32 other
 *  applications' sound, and that is worth a line. */
function appkitVersion() {
  if (process.platform !== 'darwin') return null;
  if ((process.env.REACT_X11_BACKEND ?? '').toLowerCase() === 'x11')
    return null;
  try {
    const at = process.env.REACT_X11_CALAYERS_PATH;
    if (at) {
      const dir = at.endsWith('.js') ? dirname(at) : at;
      return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
        .version;
    }
    return createRequire(import.meta.url)('@windowkit/appkit/package.json')
      .version;
  } catch {
    return null;
  }
}

function Bridge() {
  // on macOS but answered by something else — X11 on XQuartz, a test's
  // fakes — the bridge is not what is in use
  const screen = useDesktopCapability('screenCapture');
  const version = appkitVersion();
  if (version === null) return null;
  if (screen.backend && screen.backend !== 'cocoa') return null;
  const [major, minor] = version.split('.').map(Number);
  const short =
    major !== 0 || minor >= 32
      ? ''
      : minor < 31
        ? ' — capture needs 0.31 or later: run npm install'
        : ' — system audio needs 0.32 or later: run npm install';
  return (
    <text style={s.dim}>
      @windowkit/appkit {version}
      {short}
    </text>
  );
}

function Capability({ name }) {
  const c = useDesktopCapability(name);
  const on = Object.entries(c.features)
    .filter(([, v]) => v)
    .map(([k]) => k);
  return (
    <text style={s.text}>
      {name}: {c.available ? c.backend : 'unavailable'}
      {on.length ? ` — ${on.join(', ')}` : ''}
    </text>
  );
}

function Permission({ kind, log }) {
  const p = usePermission(kind);
  return (
    <box style={s.row}>
      <text style={s.text}>
        {kind}: {p.available ? p.status : 'nothing here asks'}
      </text>
      <Button
        label="Request"
        disabled={!p.available}
        onPress={() =>
          p.request().then(
            (status) => log(`${kind}: request answered ${status}`),
            (e) => log(`${kind}: request failed — ${e.message}`),
          )
        }
      />
      <Button label="Settings" onPress={() => p.openSettings(kind)} />
    </box>
  );
}

function Devices() {
  const { devices, settled } = useMediaDevices();
  if (!settled) return <text style={s.dim}>listing…</text>;
  if (devices.length === 0) {
    return <text style={s.dim}>no devices — nothing here can list them</text>;
  }
  const KIND = {
    videoinput: 'camera',
    audioinput: 'mic',
    audiooutput: 'speaker',
    systemaudio: 'sound',
  };
  return devices.map((d) => (
    <text key={`${d.kind}:${d.deviceId}`} style={s.text}>
      {KIND[d.kind] ?? d.kind}
      {': '}
      {d.label || d.deviceId}
      {d.isDefault ? ' (default)' : ''}
    </text>
  ));
}

// --- camera --------------------------------------------------------------------

const SIZES = ['640x480', '1280x720', '1920x1080'];

function Camera({ log }) {
  const { cameras } = useMediaDevices();
  const [deviceId, setDeviceId] = useState(DEFAULT);
  const [size, setSize] = useState('1280x720');
  const [width, height] = size.split('x').map(Number);
  const call = useUserMedia(
    {
      video: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        width,
        height,
        frameRate: 30,
      },
    },
    { start: false },
  );
  useStatusLog('camera', call, log);
  const track = useTrack(call.stream, 'video');
  const [enabled, setEnabled] = useState(true);
  const [reading, setReading] = useState(false);
  const [stats, setStats] = useState(null);

  useEffect(() => {
    if (track) track.enabled = enabled;
  }, [track, enabled]);

  // frames read in JavaScript, counted: on macOS a preview reads none, and
  // this is what turns the crossing on
  useEffect(() => {
    if (!track || !reading) {
      setStats(null);
      return undefined;
    }
    let count = 0;
    let what = '';
    let since = performance.now();
    const off = track.onFrame((f) => {
      count += 1;
      what = `${f.format} ${f.width}x${f.height} ${f.colorSpace}/${f.range}`;
    });
    const timer = setInterval(() => {
      const now = performance.now();
      setStats(
        `${what || 'no frames'}, ${((count * 1000) / (now - since)).toFixed(1)} fps`,
      );
      count = 0;
      since = now;
    }, 1000);
    return () => {
      off();
      clearInterval(timer);
    };
  }, [track, reading]);

  return (
    <Section title="Camera">
      <box style={s.row}>
        <Select
          value={deviceId}
          options={deviceOptions(cameras)}
          onChange={(ev) => setDeviceId(valueOf(ev))}
        />
        <Select
          value={size}
          options={SIZES}
          onChange={(ev) => setSize(valueOf(ev))}
        />
        <Button
          label={call.stream ? 'Stop' : 'Start'}
          onPress={call.stream ? call.stop : call.start}
        />
      </box>
      <video srcObject={call.stream} style={s.picture} />
      <box style={s.row}>
        <Checkbox
          label="enabled"
          checked={enabled}
          onChange={(ev) => setEnabled(checkedOf(ev))}
        />
        <Checkbox
          label="read frames in JS"
          checked={reading}
          onChange={(ev) => setReading(checkedOf(ev))}
        />
      </box>
      <text style={s.dim}>status: {call.status}</text>
      <text style={s.dim}>{settingsLine(track)}</text>
      {stats && <text style={s.dim}>{stats}</text>}
    </Section>
  );
}

// --- a track's level ----------------------------------------------------------------

/** The loudest sample of each tenth of a second off an audio track, and
 *  what a chunk of it is. */
function useLevel(track) {
  const [peak, setPeak] = useState(0);
  const [chunk, setChunk] = useState(null);
  useEffect(() => {
    if (!track) {
      setPeak(0);
      setChunk(null);
      return undefined;
    }
    let loudest = 0;
    let shape = null;
    const off = track.onFrame((d) => {
      shape = `${d.frames} frames at ${d.sampleRate} Hz, ${d.channels.length} ch`;
      for (const channel of d.channels) {
        for (let i = 0; i < channel.length; i++) {
          const v = Math.abs(channel[i]);
          if (v > loudest) loudest = v;
        }
      }
    });
    const timer = setInterval(() => {
      setPeak(loudest);
      setChunk(shape);
      loudest = 0;
    }, 100);
    return () => {
      off();
      clearInterval(timer);
    };
  }, [track]);
  return { peak, chunk };
}

function Meter({ peak }) {
  const db = 20 * Math.log10(Math.max(peak, 1e-5));
  const fill = Math.max(0, Math.min(1, (db + 60) / 60));
  return (
    <box style={s.row}>
      <box style={s.meter}>
        <box
          style={{
            width: `${Math.round(fill * 100)}%`,
            flexGrow: 0,
            backgroundColor: db > -6 ? '#d0453a' : '$accent',
          }}
        />
      </box>
      <text style={s.dim}>{peak > 0 ? `${db.toFixed(0)} dBFS` : '—'}</text>
    </box>
  );
}

// --- microphone ----------------------------------------------------------------

function Microphone({ log, speaker }) {
  const { microphones } = useMediaDevices();
  const [deviceId, setDeviceId] = useState(DEFAULT);
  const [echo, setEcho] = useState(true);
  const [rate, setRate] = useState(48000);
  const [hear, setHear] = useState(false);
  const call = useUserMedia(
    {
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        echoCancellation: echo,
        sampleRate: rate,
        channelCount: 1,
      },
    },
    { start: false },
  );
  useStatusLog('microphone', call, log);
  const track = useTrack(call.stream, 'audio');
  const { peak, chunk } = useLevel(track);

  return (
    <Section title="Microphone">
      <box style={s.row}>
        <Select
          value={deviceId}
          options={deviceOptions(microphones)}
          onChange={(ev) => setDeviceId(valueOf(ev))}
        />
        <Select
          value={rate}
          options={[
            { value: 48000, label: '48 kHz' },
            { value: 16000, label: '16 kHz' },
          ]}
          onChange={(ev) => setRate(valueOf(ev))}
        />
        <Button
          label={call.stream ? 'Stop' : 'Start'}
          onPress={call.stream ? call.stop : call.start}
        />
      </box>
      <box style={s.row}>
        <Checkbox
          label="echo cancellation"
          checked={echo}
          onChange={(ev) => setEcho(checkedOf(ev))}
        />
        <Checkbox
          label="hear yourself (headphones!)"
          checked={hear}
          onChange={(ev) => setHear(checkedOf(ev))}
        />
      </box>
      <Meter peak={peak} />
      <text style={s.dim}>status: {call.status}</text>
      <text style={s.dim}>{settingsLine(track)}</text>
      {chunk && <text style={s.dim}>{chunk}</text>}
      {hear && call.stream && (
        <audio
          srcObject={call.stream}
          sinkId={speaker || undefined}
          onError={(e) => log(`hear yourself: ${e.name}: ${e.message}`)}
        />
      )}
    </Section>
  );
}

// --- audio out ---------------------------------------------------------------------

/** One second of 440 Hz at -14 dBFS, faded in and out over 10 ms. */
function tone(rate) {
  const out = new Float32Array(rate);
  const fade = rate / 100;
  for (let i = 0; i < out.length; i++) {
    const edge = Math.min(1, i / fade, (out.length - i) / fade);
    out[i] = 0.2 * edge * Math.sin((2 * Math.PI * 440 * i) / rate);
  }
  return out;
}

function AudioOut({ log, speaker, setSpeaker }) {
  const app = useApp();
  const { speakers } = useMediaDevices();
  const [state, setState] = useState(null);
  const playing = useRef(null);

  useEffect(() => () => playing.current?.(), []);

  const play = () => {
    playing.current?.();
    let sink;
    try {
      sink = createAudioFrames(app, {
        sampleRate: 48000,
        channels: 2,
        deviceId: speaker || undefined,
      });
    } catch (e) {
      log(`audio out: ${e.name}: ${e.message}`);
      return;
    }
    const samples = tone(48000);
    sink.push([samples, samples]);
    log(
      `audio out: 1 s queued, latency ${(sink.latency * 1000).toFixed(1)} ms`,
    );
    const begun = performance.now();
    const timer = setInterval(() => {
      setState(
        `played ${sink.currentTime.toFixed(2)} s, queued ${sink.queued.toFixed(2)} s`,
      );
      if (sink.queued === 0 && performance.now() - begun > 1300) stop();
    }, 100);
    const stop = () => {
      clearInterval(timer);
      sink.close();
      playing.current = null;
    };
    playing.current = stop;
  };

  return (
    <Section title="Audio out">
      <box style={s.row}>
        <Select
          value={speaker}
          options={deviceOptions(speakers)}
          onChange={(ev) => setSpeaker(valueOf(ev))}
        />
        <Button label="Play a tone" onPress={play} />
      </box>
      <text style={s.dim}>
        {state ?? 'one second of 440 Hz through createAudioFrames'}
      </text>
    </Section>
  );
}

// --- the screen ------------------------------------------------------------------------

function Screen({ log, windowRef, exclude, setExclude }) {
  const app = useApp();
  const caps = useDesktopCapability('screenCapture');
  const [sources, setSources] = useState([]);
  const [source, setSource] = useState(DEFAULT);
  const [shot, setShot] = useState(null);
  const share = useDisplayMedia({
    ...(source ? { source } : {}),
    video: { frameRate: 15 },
  });
  useStatusLog('share', share, log);

  const list = useCallback(async () => {
    const found = await displaySources({ app });
    setSources(found);
    log(
      `displaySources: ${found.length} — ${found.map((one) => one.id).join(', ') || 'none'}`,
    );
  }, [app, log]);
  useEffect(() => {
    list();
  }, [list]);

  /** This window as a source: a window number on macOS, an XID on X11. */
  const thisWindow = () => {
    const w = windowRef.current;
    const id = w?.windowNumber ?? w?.id;
    return id != null ? `window:${id}` : null;
  };

  const take = async (what, options) => {
    try {
      const picture = await captureScreenshot({ app, ...options });
      const path = join(tmpdir(), `react-x11-${what}-${Date.now()}.png`);
      writeFileSync(path, picture.png());
      setShot({
        width: picture.width,
        height: picture.height,
        data: picture.data,
      });
      log(
        `screenshot of ${what}: ${picture.width}x${picture.height} → ${path}`,
      );
    } catch (e) {
      log(`screenshot of ${what}: ${e.name}: ${e.message}`);
    }
  };

  return (
    <Section title="Screen">
      <box style={s.row}>
        <Select
          value={source}
          options={[
            { value: DEFAULT, label: 'Primary screen' },
            ...sources.map((one) => ({
              value: one.id,
              label: `${one.name || one.id} (${one.width}x${one.height})`,
            })),
          ]}
          onChange={(ev) => setSource(valueOf(ev))}
        />
        <Button label="List" onPress={list} />
      </box>
      <box style={s.row}>
        <Button
          label="Screenshot"
          onPress={() => take('source', source ? { source } : {})}
        />
        <Button
          label="Top-left 400x300"
          onPress={() =>
            take('region', {
              ...(source ? { source } : {}),
              region: { x: 0, y: 0, width: 400, height: 300 },
            })
          }
        />
        {windowRef && (
          <Button
            label="This window"
            onPress={() => {
              const id = thisWindow();
              if (id) take('window', { source: id });
              else log('this window has no id yet');
            }}
          />
        )}
      </box>
      {windowRef && (
        <Checkbox
          label="keep this window out of captures"
          checked={exclude}
          onChange={(ev) => setExclude(checkedOf(ev))}
        />
      )}
      {shot && <image src={shot} style={s.picture} />}
      <box style={s.row}>
        <Button
          label={share.stream ? 'Stop sharing' : 'Share'}
          disabled={!caps.features.streams}
          onPress={share.stream ? share.stop : share.start}
        />
        <text style={s.dim}>
          {caps.features.streams
            ? `share: ${share.status}`
            : 'no screen streams here yet — screenshots only'}
        </text>
      </box>
      {share.stream && <video srcObject={share.stream} style={s.picture} />}
    </Section>
  );
}

// --- other applications' sound ---------------------------------------------------------

/** Planar floats as a 16-bit PCM WAV file's bytes. */
function wav(channels, sampleRate) {
  const frames = channels[0]?.length ?? 0;
  const n = channels.length;
  const out = Buffer.alloc(44 + frames * n * 2);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + frames * n * 2, 4);
  out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(n, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * n * 2, 28);
  out.writeUInt16LE(n * 2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36);
  out.writeUInt32LE(frames * n * 2, 40);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < n; c++) {
      const v = Math.max(-1, Math.min(1, channels[c][i]));
      out.writeInt16LE(Math.round(v * 32767), 44 + (i * n + c) * 2);
    }
  }
  return out;
}

// what "Save WAV" keeps: a minute is plenty to listen to
const KEEP_SECONDS = 60;

function SystemAudio({ log }) {
  const caps = useDesktopCapability('systemAudio');
  const { systemAudio } = useMediaDevices();
  const [source, setSource] = useState('system-audio');
  const [rate, setRate] = useState(48000);
  const [channels, setChannels] = useState(2);
  const call = useUserMedia(
    {
      audio: {
        deviceId: { exact: source },
        sampleRate: rate,
        channelCount: channels,
      },
    },
    { start: false },
  );
  useStatusLog('system audio', call, log);
  const track = useTrack(call.stream, 'audio');
  const { peak, chunk } = useLevel(track);
  const kept = useRef({ chunks: [], frames: 0, rate: 0 });

  // every chunk copied, a minute at the most, for "Save WAV"
  useEffect(() => {
    if (!track) return undefined;
    kept.current = { chunks: [], frames: 0, rate: 0 };
    return track.onFrame((d) => {
      const k = kept.current;
      k.rate = d.sampleRate;
      k.chunks.push(d.channels.map((c) => Float32Array.from(c)));
      k.frames += d.frames;
      while (k.frames > KEEP_SECONDS * d.sampleRate && k.chunks.length > 1) {
        k.frames -= k.chunks.shift()[0].length;
      }
    });
  }, [track]);

  const save = () => {
    const { chunks, frames, rate: at } = kept.current;
    if (!frames) {
      log('system audio: nothing recorded yet');
      return;
    }
    const joined = chunks[0].map((_, c) => {
      const all = new Float32Array(frames);
      let i = 0;
      for (const one of chunks) {
        all.set(one[c], i);
        i += one[c].length;
      }
      return all;
    });
    const path = join(tmpdir(), `react-x11-system-audio-${Date.now()}.wav`);
    writeFileSync(path, wav(joined, at));
    log(`system audio: ${(frames / at).toFixed(1)} s saved → ${path}`);
  };

  if (!caps.available) {
    return (
      <Section title="System audio">
        <text style={s.dim}>
          nothing here records other applications' sound — macOS 14.2 and
          @windowkit/appkit 0.32 or later
        </text>
      </Section>
    );
  }
  return (
    <Section title="System audio">
      <box style={s.row}>
        <Select
          value={source}
          options={systemAudio.map((d) => ({
            value: d.deviceId,
            label: `${d.label || d.deviceId}${d.playing ? ' — playing' : ''}`,
          }))}
          onChange={(ev) => setSource(valueOf(ev))}
        />
        <Select
          value={rate}
          options={[
            { value: 48000, label: '48 kHz' },
            { value: 16000, label: '16 kHz' },
          ]}
          onChange={(ev) => setRate(valueOf(ev))}
        />
        <Select
          value={channels}
          options={[
            { value: 2, label: 'stereo' },
            { value: 1, label: 'mono' },
          ]}
          onChange={(ev) => setChannels(valueOf(ev))}
        />
      </box>
      <box style={s.row}>
        <Button
          label={call.stream ? 'Stop recording' : 'Record'}
          onPress={call.stream ? call.stop : call.start}
        />
        <Button label="Save WAV" onPress={save} />
      </box>
      <Meter peak={peak} />
      <text style={s.dim}>status: {call.status}</text>
      <text style={s.dim}>{settingsLine(track)}</text>
      {chunk && <text style={s.dim}>{chunk}</text>}
      <text style={s.dim}>
        {caps.features.excludesSelf
          ? '"System audio" leaves this app out: its tone should not move the meter'
          : "this app's own sound is in the recording too"}
      </text>
    </Section>
  );
}

// --- the window ------------------------------------------------------------------------

const CAPABILITIES = [
  'camera',
  'audioInput',
  'audioOutput',
  'screenCapture',
  'systemAudio',
];
const PERMISSIONS = [
  'camera',
  'microphone',
  'screen-recording',
  'system-audio-recording',
];

/** The lab's sections and its log: in its window (`App`), or in a pane
 *  (media-capture-pane.jsx), which has no window to capture or keep out. */
export function Lab({ windowRef = null, exclude = false, setExclude = null }) {
  const [lines, setLines] = useState([]);
  const [speaker, setSpeaker] = useState(DEFAULT);
  const log = useCallback((line) => {
    const stamp = new Date().toTimeString().slice(0, 8);
    // the terminal gets it too, for pasting into a report
    if (!process.env.REACT_X11_NO_AUTORUN)
      console.log(`[media-capture] ${line}`);
    setLines((all) => [...all.slice(-40), `${stamp}  ${line}`]);
  }, []);

  return (
    <box style={s.root}>
      <box style={s.scroll}>
        <box style={s.columns}>
          <box style={s.column}>
            <Section title="What this display can do">
              <Bridge />
              {CAPABILITIES.map((name) => (
                <Capability key={name} name={name} />
              ))}
            </Section>
            <Section title="Permissions">
              {PERMISSIONS.map((kind) => (
                <Permission key={kind} kind={kind} log={log} />
              ))}
            </Section>
            <Section title="Devices">
              <Devices />
            </Section>
            <Microphone log={log} speaker={speaker} />
          </box>
          <box style={s.column}>
            <Camera log={log} />
            <AudioOut log={log} speaker={speaker} setSpeaker={setSpeaker} />
            <Screen
              log={log}
              windowRef={windowRef}
              exclude={exclude}
              setExclude={setExclude}
            />
            <SystemAudio log={log} />
          </box>
        </box>
      </box>
      <box style={s.log}>
        {lines.map((line, i) => (
          <text key={i} style={s.dim}>
            {line}
          </text>
        ))}
      </box>
    </box>
  );
}

export function App() {
  const windowRef = useRef(null);
  const [exclude, setExclude] = useState(false);
  return (
    <window
      ref={windowRef}
      title="react-x11 media capture"
      width={1000}
      height={820}
      excludeFromCapture={exclude}
    >
      <Lab windowRef={windowRef} exclude={exclude} setExclude={setExclude} />
    </window>
  );
}

const PANE = new URL('./media-capture-pane.jsx', import.meta.url);

/** The lab in a `<Frame>` pane: `--pane`. */
export function PaneHost() {
  return (
    <window
      title="react-x11 media capture, in a pane"
      width={1000}
      height={820}
    >
      <Frame
        src={PANE}
        style={{ flexGrow: 1 }}
        fallback={({ error, restart }) => (
          <box style={{ flexGrow: 1, padding: 16, gap: 10 }}>
            <text>{`the pane is gone: ${error?.message ?? 'unknown'}`}</text>
            <Button label="Restart" onPress={restart} />
          </box>
        )}
      />
    </window>
  );
}

export default App;

// not in the pane, which imports `Lab` from here
if (!process.env.REACT_X11_NO_AUTORUN && !isFramed()) {
  const root = await createRoot();
  root.render(process.argv.includes('--pane') ? <PaneHost /> : <App />);
}

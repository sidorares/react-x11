#!/usr/bin/env node
// What a CI runner offers the Wayland backend's GPU path, recorded rather
// than asserted. .github/workflows/wayland-probe.yml runs this on GitHub's
// hosted runners, and its answers decide what an e2e job can test.
//
//   node wayland-ci-probe.mjs gpu                x11-dri on every DRM node
//   node wayland-ci-probe.mjs compositor <name>  start one headless
//                                                compositor, read its
//                                                globals, and import
//                                                dma-bufs into it
//
// The backend presents only through zwp_linux_dmabuf_v1, from a GBM/EGL
// context on a DRM node (src/wayland/glcontext.js). A hosted runner has no
// render node, so the questions are: can x11-dri open a context on what is
// there — a card node, vkms after `modprobe` — and will any compositor both
// advertise linux-dmabuf and take a buffer: a GPU one, or a udmabuf, which
// needs no GPU at all.
//
// Results go to stdout, and as tables to $GITHUB_STEP_SUMMARY when that is
// set; each compositor's output is kept under $PROBE_LOGS. The exit code is
// 0 unless the script itself breaks: a probe that finds nothing has still
// answered.
//
// Run it from a directory where `@windowkit/wayland` and `x11-dri` are
// installed. The workflow makes one, so the probe asks what the published
// packages can do rather than what this repository's lockfile pins.

import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dri = require('x11-dri');
const { Display } = await import('@windowkit/wayland');

/** Buffers are this many pixels square: enough to import, cheap to fill. */
const SIZE = 64;
const LOGS = process.env.PROBE_LOGS ?? path.join(process.cwd(), 'logs');
fs.mkdirSync(LOGS, { recursive: true });

/** Where Ubuntu and Arch put linux-dmabuf's XML, stable first. */
const DMABUF_XML = [
  '/usr/share/wayland-protocols/stable/linux-dmabuf/linux-dmabuf-v1.xml',
  '/usr/share/wayland-protocols/unstable/linux-dmabuf/linux-dmabuf-unstable-v1.xml',
];

const message = (err) => String(err?.message ?? err).split('\n')[0];
const hex = (v) => `0x${BigInt(v).toString(16)}`;

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${what}: no answer in ${ms / 1000} s`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

// ---- reporting --------------------------------------------------------------

/** One table: a title and rows of what was asked, the answer, and detail. */
function report(title, rows) {
  const width = Math.max(...rows.map((r) => r.what.length), 4);
  console.log(`\n== ${title}`);
  for (const r of rows)
    console.log(`  ${r.what.padEnd(width)}  ${r.result}  ${r.detail ?? ''}`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (!summary) return;
  const cell = (s) => String(s ?? '').replace(/\|/g, '\\|');
  fs.appendFileSync(
    summary,
    `\n#### ${title}\n\n| probe | result | detail |\n| --- | --- | --- |\n` +
      rows
        .map(
          (r) => `| ${cell(r.what)} | ${cell(r.result)} | ${cell(r.detail)} |`,
        )
        .join('\n') +
      '\n',
  );
}

const yes = (what, detail) => ({ what, result: 'yes', detail });
const no = (what, detail) => ({ what, result: 'no', detail });

// ---- devices ------------------------------------------------------------------

/** Every DRM node, with the kernel driver behind it. */
function drmNodes() {
  let names;
  try {
    names = fs.readdirSync('/dev/dri');
  } catch {
    return [];
  }
  return names
    .filter((n) => /^(card|renderD)\d+$/.test(n))
    .sort()
    .map((name) => {
      let driver = '?';
      try {
        driver = path.basename(
          fs.realpathSync(`/sys/class/drm/${name}/device/driver`),
        );
      } catch {
        /* no sysfs entry */
      }
      return { name, path: `/dev/dri/${name}`, driver };
    });
}

/**
 * Open a GPU context on one node, draw a frame and swap it, which is where
 * the dma-buf comes from. The caller destroys what comes back.
 */
function openGpu(node, { linear = false } = {}) {
  let gpu;
  let surface;
  try {
    gpu = new dri.Gpu({ devicePath: node.path, format: dri.FORMAT.XRGB8888 });
    surface = linear
      ? gpu.createSurface(
          SIZE,
          SIZE,
          dri.GBM_USE.RENDERING | dri.GBM_USE.LINEAR,
        )
      : gpu.createSurface(SIZE, SIZE);
    gpu.makeCurrent(surface);
    const gl = gpu.gl;
    gl.clearColor(0, 0.5, 1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT ?? dri.GL?.COLOR_BUFFER_BIT ?? 0x4000);
    const out = surface.swap();
    const destroy = () => {
      try {
        surface.destroy?.();
      } catch {
        /* already gone */
      }
      try {
        gpu.destroy();
      } catch {
        /* already gone */
      }
    };
    return { gpu, out, destroy };
  } catch (err) {
    try {
      surface?.destroy?.();
    } catch {
      /* already gone */
    }
    try {
      gpu?.destroy();
    } catch {
      /* already gone */
    }
    return { error: message(err) };
  }
}

function describeGpu({ gpu, out }) {
  const version = gpu.glVersion ? JSON.stringify(gpu.glVersion) : '?';
  const buffer = out?.isNew
    ? `modifier ${hex(out.modifier)}, stride ${out.stride}`
    : 'swap gave no new buffer';
  return `${gpu.eglVendor} ${gpu.eglVersion}; GL ES ${version}; dmabufImport=${gpu.features?.dmabufImport}; ${buffer}`;
}

function probeGpu() {
  const p = dri.probe();
  report('x11-dri', [
    { what: 'platform', result: p.platform },
    { what: 'gbm', result: String(p.gbm) },
    { what: 'egl', result: String(p.egl) },
    { what: 'gles', result: String(p.gles) },
    { what: 'udmabuf', result: String(p.udmabuf) },
    {
      what: 'render nodes',
      result: dri.listRenderNodes().join(', ') || 'none',
    },
  ]);

  const nodes = drmNodes();
  const rows = [];
  if (!nodes.length) rows.push(no('/dev/dri', 'no DRM nodes at all'));
  for (const node of nodes) {
    for (const linear of [false, true]) {
      const what = `${node.name} (${node.driver})${linear ? ', linear' : ''}`;
      const g = openGpu(node, { linear });
      if (g.error) {
        rows.push(no(what, g.error));
        continue;
      }
      rows.push(yes(what, describeGpu(g)));
      g.destroy();
    }
  }
  try {
    const u = dri.createUdmabuf(SIZE * SIZE * 4);
    rows.push(yes('createUdmabuf', `${u.size} bytes`));
    u.close();
  } catch (err) {
    rows.push(no('createUdmabuf', message(err)));
  }
  report('GPU contexts', rows);
}

// ---- compositors ------------------------------------------------------------------

/** A placeholder the runner swaps for the path of a per-run sway config. */
const SWAY_CONFIG = Symbol('sway config');
const SOCKET = 'wl-probe';

function weston(renderer) {
  // Weston 10 changed how the renderer is named, and 14 the backend; try
  // the spellings in order and keep the first that comes up.
  const spellings =
    renderer === 'gl'
      ? [
          ['--backend=headless', '--renderer=gl'],
          ['--backend=headless-backend.so', '--renderer=gl'],
          ['--backend=headless-backend.so', '--use-gl'],
        ]
      : [
          ['--backend=headless', '--renderer=pixman'],
          ['--backend=headless-backend.so'],
        ];
  return spellings.map((flags) => ({
    label: `weston ${flags.join(' ')}`,
    cmd: 'weston',
    args: [...flags, `--socket=${SOCKET}`, '--idle-time=0'],
    env: {},
    firstThatStarts: true,
  }));
}

function sway(renderer, node) {
  const env = {
    WLR_BACKENDS: 'headless',
    WLR_RENDERER: renderer,
    WLR_LIBINPUT_NO_DEVICES: '1',
  };
  if (renderer !== 'pixman') env.WLR_RENDERER_ALLOW_SOFTWARE = '1';
  if (node) env.WLR_RENDER_DRM_DEVICE = node.path;
  return {
    label: `sway ${renderer}${node ? ` on ${node.name} (${node.driver})` : ''}`,
    cmd: 'sway',
    args: ['-c', SWAY_CONFIG],
    env,
  };
}

const COMPOSITORS = {
  'weston-gl': () => weston('gl'),
  'weston-pixman': () => weston('pixman'),
  'sway-pixman': () => [sway('pixman')],
  'sway-gles2': () => [
    sway('gles2'),
    ...drmNodes().map((n) => sway('gles2', n)),
  ],
  kwin: () => [
    {
      label: 'kwin_wayland --virtual',
      cmd: 'dbus-run-session',
      args: [
        '--',
        'kwin_wayland',
        '--virtual',
        '--no-lockscreen',
        '--socket',
        SOCKET,
        '--width',
        '1280',
        '--height',
        '800',
      ],
      env: {},
    },
  ],
};

/** The socket a compositor made in its runtime dir, once there is one. */
async function waitForSocket(runtime, hasExited, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && hasExited() === null) {
    for (const name of fs.readdirSync(runtime)) {
      if (!name.startsWith(SOCKET) && !name.startsWith('wayland-')) continue;
      if (name.endsWith('.lock')) continue;
      try {
        if (fs.statSync(path.join(runtime, name)).isSocket()) return name;
      } catch {
        /* raced with its creation */
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

/** The lines of a compositor's log that say which renderer it chose. */
function rendererLines(logPath) {
  let text = '';
  try {
    text = fs.readFileSync(logPath, 'utf8');
  } catch {
    return '';
  }
  return text
    .split('\n')
    .filter((l) =>
      /renderer|GL vendor|GL renderer|llvmpipe|EGL|udmabuf/i.test(l),
    )
    .slice(0, 4)
    .map((l) => l.trim().slice(0, 160))
    .join(' / ');
}

async function runCompositor(spec) {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-probe-'));
  fs.chmodSync(runtime, 0o700);
  const config = path.join(runtime, 'sway.conf');
  fs.writeFileSync(config, 'output * resolution 1280x800\nxwayland disable\n');
  const slug = spec.label.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
  const logPath = path.join(LOGS, `${slug}.log`);
  const log = fs.openSync(logPath, 'w');
  const env = { ...process.env, XDG_RUNTIME_DIR: runtime, ...spec.env };
  delete env.WAYLAND_DISPLAY;
  delete env.DISPLAY;

  let exited = null;
  const child = spawn(
    spec.cmd,
    spec.args.map((a) => (a === SWAY_CONFIG ? config : a)),
    { env, stdio: ['ignore', log, log], detached: true },
  );
  child.on('exit', (code, signal) => {
    exited = signal ?? code;
  });
  child.on('error', (err) => {
    exited = message(err);
  });

  try {
    const socket = await waitForSocket(runtime, () => exited, 15000);
    if (!socket) {
      return {
        started: false,
        reason:
          exited !== null
            ? `exited before its socket: ${exited}`
            : 'no socket in 15 s',
        logPath,
      };
    }
    const info = waylandInfo(runtime, socket, slug);
    const imports = await probeClient(path.join(runtime, socket));
    return { started: true, socket, info, imports, logPath };
  } finally {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
    if (exited === null) {
      await Promise.race([
        once(child, 'exit'),
        new Promise((r) => setTimeout(r, 3000)),
      ]);
    }
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
    fs.closeSync(log);
  }
}

/** `wayland-info`'s view: every global, and linux-dmabuf's version. */
function waylandInfo(runtime, socket, slug) {
  try {
    const text = execFileSync('wayland-info', [], {
      env: {
        ...process.env,
        XDG_RUNTIME_DIR: runtime,
        WAYLAND_DISPLAY: socket,
      },
      encoding: 'utf8',
      timeout: 10000,
    });
    fs.writeFileSync(path.join(LOGS, `${slug}.wayland-info.txt`), text);
    const globals = [
      ...text.matchAll(/interface: '([^']+)',\s*version:\s*(\d+)/g),
    ];
    const dmabuf = globals.find((g) => g[1] === 'zwp_linux_dmabuf_v1');
    const device = text.match(/main device[^\n]*/i)?.[0]?.trim();
    return {
      count: globals.length,
      dmabuf: dmabuf ? Number(dmabuf[2]) : null,
      device: device ?? '',
    };
  } catch (err) {
    return { error: message(err) };
  }
}

/**
 * One connection per question: a compositor that refuses a buffer may do it
 * with a fatal protocol error, and that must not decide the next answer.
 */
async function withConnection(socketPath, fn) {
  const socket = new dri.UnixSocket(socketPath);
  await withTimeout(once(socket, 'connect'), 5000, 'connect');
  const display = new Display(socket);
  const died = new Promise((resolve) => {
    display.once('error', (err) => resolve(`protocol error: ${message(err)}`));
    display.once('close', () => resolve('connection closed'));
  });
  try {
    await withTimeout(display.init(), 5000, 'wl_display init');
    return await Promise.race([fn(display), died]);
  } finally {
    socket.destroy();
  }
}

async function bindDmabuf(display) {
  const xml = DMABUF_XML.find((p) => fs.existsSync(p));
  if (!xml) throw new Error('wayland-protocols is not installed');
  await display.load(xml);
  // version 3: the last one that lists modifiers as plain events
  return await display.bind('zwp_linux_dmabuf_v1', 3);
}

/** Send one buffer through linux-dmabuf and report what the compositor said. */
async function importBuffer(dmabuf, b) {
  const params = await dmabuf.create_params();
  const outcome = new Promise((resolve) => {
    params.once('created', () => resolve('created'));
    params.once('failed', () => resolve('failed'));
  });
  const modifier = BigInt(b.modifier);
  await params.add(
    b.fd,
    0,
    b.offset >>> 0,
    b.stride >>> 0,
    Number(modifier >> 32n) >>> 0,
    Number(modifier & 0xffffffffn) >>> 0,
  );
  await params.create(b.width, b.height, b.format, 0);
  return await withTimeout(outcome, 3000, 'create');
}

async function probeClient(socketPath) {
  const rows = [];
  let advertised = false;

  try {
    rows.push(
      await withConnection(socketPath, async (display) => {
        // an iterator over the registry's interface names, not an array
        advertised = [...display.listGlobals()].includes('zwp_linux_dmabuf_v1');
        if (!advertised) return no('zwp_linux_dmabuf_v1', 'not advertised');
        const dmabuf = await bindDmabuf(display);
        const modifiers = new Map();
        dmabuf.on('modifier', (format, hi, lo) => {
          const list = modifiers.get(format) ?? [];
          list.push(hex((BigInt(hi) << 32n) | BigInt(lo)));
          modifiers.set(format, list);
        });
        await display.sync();
        const xrgb = modifiers.get(dri.FORMAT.XRGB8888) ?? [];
        return yes(
          'zwp_linux_dmabuf_v1',
          `${modifiers.size} formats; XRGB8888 modifiers: ${xrgb.join(' ') || 'none listed'}`,
        );
      }),
    );
  } catch (err) {
    rows.push(no('client connection', message(err)));
    return rows;
  }
  if (!advertised) return rows;

  // A udmabuf: CPU memory as a linear dma-buf, no GPU anywhere.
  try {
    const u = dri.createUdmabuf(SIZE * SIZE * 4);
    new Uint32Array(u.buffer).fill(0xff0080ff);
    const answer = await withConnection(socketPath, async (display) =>
      importBuffer(await bindDmabuf(display), {
        fd: dri.dup(u.fd),
        offset: 0,
        stride: SIZE * 4,
        modifier: dri.MODIFIER.LINEAR,
        width: SIZE,
        height: SIZE,
        format: dri.FORMAT.XRGB8888,
      }),
    );
    u.close();
    rows.push({ what: 'import udmabuf, linear', result: answer });
  } catch (err) {
    rows.push(no('import udmabuf, linear', message(err)));
  }

  // What the backend would send: a buffer from a GBM surface on each node.
  for (const node of drmNodes()) {
    for (const linear of [false, true]) {
      const what = `import GPU buffer from ${node.name}${linear ? ', linear' : ''}`;
      const g = openGpu(node, { linear });
      if (g.error) {
        rows.push({ what, result: 'n/a', detail: `no context: ${g.error}` });
        continue;
      }
      try {
        if (!g.out?.isNew) {
          rows.push({ what, result: 'n/a', detail: 'swap gave no new buffer' });
          continue;
        }
        const answer = await withConnection(socketPath, async (display) =>
          importBuffer(await bindDmabuf(display), {
            ...g.out,
            format: dri.FORMAT.XRGB8888,
          }),
        );
        rows.push({
          what,
          result: answer,
          detail: `modifier ${hex(g.out.modifier)}`,
        });
      } catch (err) {
        rows.push(no(what, message(err)));
      } finally {
        g.destroy();
      }
    }
  }
  return rows;
}

async function probeCompositors(name) {
  const make = COMPOSITORS[name];
  if (!make) {
    throw new Error(
      `unknown compositor ${JSON.stringify(name)}: ${Object.keys(COMPOSITORS).join(', ')}`,
    );
  }
  for (const spec of make()) {
    const r = await runCompositor(spec);
    const rows = [];
    if (!r.started) {
      rows.push(no('started', r.reason));
      rows.push({ what: 'log', result: '', detail: rendererLines(r.logPath) });
      report(spec.label, rows);
      // a spelling this weston does not know: try the next
      continue;
    }
    rows.push(yes('started', `socket ${r.socket}`));
    const renderer = rendererLines(r.logPath);
    if (renderer) rows.push({ what: 'renderer', result: '', detail: renderer });
    if (r.info.error) rows.push(no('wayland-info', r.info.error));
    else {
      rows.push({
        what: 'wayland-info',
        result: `${r.info.count} globals`,
        detail:
          r.info.dmabuf === null
            ? 'no zwp_linux_dmabuf_v1'
            : `zwp_linux_dmabuf_v1 v${r.info.dmabuf}${r.info.device ? `; ${r.info.device}` : ''}`,
      });
    }
    rows.push(...r.imports);
    report(spec.label, rows);
    if (spec.firstThatStarts) break;
  }
}

// ---- main ---------------------------------------------------------------------------

const [mode, arg] = process.argv.slice(2);
if (mode === 'gpu') probeGpu();
else if (mode === 'compositor') await probeCompositors(arg);
else {
  console.error('usage: wayland-ci-probe.mjs gpu | compositor <name>');
  process.exit(2);
}
// A GPU context or a socket can keep the loop alive; the answers are in.
process.exit(0);

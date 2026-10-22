// `<video frames>` on Wayland: a frame's planes go up as textures as the
// decoder made them, and the colour conversion is a fragment shader drawing
// into the `<video>`'s own surface (design/architecture/video.md §5).
//
// The backend's 2D context is already a GLES rasterizer, so this is the GLX
// transport of §2.3 made native: no conversion in JavaScript for any format,
// and NV12 and I420 cross into the GPU at 1.5 bytes a pixel. Y is an R8
// texture; NV12's chroma one RG8 texture at half size, I420's two R8 ones;
// BGRA one RGBA8 texture read back to front. The shader applies the sink's
// matrix and range exactly as `frameToRGBA` does — no transfer function,
// because nothing else on this backend is colour-managed either — so a frame
// drawn here and one converted in JavaScript are the same picture, chroma
// apart: sampled bilinearly here, as a player does, and by nearest there.
//
// What it writes into is the surface the drawn presentation already keeps
// (src/nodes/video.js): a render target, which the window's context then
// composites at the picture's rect like any `drawImage`. Nothing lifts on
// Wayland — no subsurfaces, by the backend's own design — so this is the
// whole presentation.
//
// The GL is shared with every 2D context on the app (device.js): whatever
// the device's owner still has buffered is drawn before the target is
// written, the shader's vertex state lives in a vertex array of its own,
// and the device is released afterwards so the next context to draw puts
// its own state back. `UNPACK_ROW_LENGTH`, which a decoder's padded rows
// need, is set back to 0 for the uploads that assume it.

import { flushDevice, releaseDevice } from './device.js';

const VERT = `
attribute vec2 aPos;
attribute vec2 aUV;
varying vec2 vUV;
void main() {
  vUV = aUV;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 vUV;
uniform int uLayout;
uniform sampler2D uY;
uniform sampler2D uC;
uniform sampler2D uV;
uniform vec2 uChroma;
uniform mat3 uMatrix;
uniform vec3 uOffset;
void main() {
  if (uLayout == 0) {
    // BGRA bytes uploaded as RGBA: blue is in r. Opaque, whatever the
    // fourth byte held.
    gl_FragColor = vec4(texture2D(uY, vUV).bgr, 1.0);
    return;
  }
  float y = texture2D(uY, vUV).r;
  vec2 cuv = vUV * uChroma;
  vec2 c = uLayout == 1
    ? texture2D(uC, cuv).rg
    : vec2(texture2D(uC, cuv).r, texture2D(uV, cuv).r);
  vec3 rgb = uMatrix * (vec3(y, c) - uOffset);
  gl_FragColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}`;

const LAYOUT = { BGRA: 0, NV12: 1, I420: 2 };

// Kr and Kb, as src/videoframes.js has them
const MATRIX = {
  bt709: [0.2126, 0.0722],
  bt601: [0.299, 0.114],
  bt2020: [0.2627, 0.0593],
};

const matrices = new Map();

/**
 * The column-major mat3 and the offset that take normalized Y'CbCr to
 * R'G'B' for a matrix and a range — the same numbers `frameToRGBA`'s tables
 * are made of, in units of 1 rather than of 255.
 */
export function videoMatrix(colorSpace, range) {
  const key = `${colorSpace}/${range}`;
  let m = matrices.get(key);
  if (m) return m;
  const [kr, kb] = MATRIX[colorSpace];
  const kg = 1 - kr - kb;
  const full = range === 'full';
  const ys = full ? 1 : 255 / 219;
  const cs = full ? 1 : 255 / 224;
  m = {
    matrix: Float32Array.of(
      // the column Y' multiplies
      ys,
      ys,
      ys,
      // Cb
      0,
      -cs * ((2 * kb * (1 - kb)) / kg),
      cs * 2 * (1 - kb),
      // Cr
      cs * 2 * (1 - kr),
      -cs * ((2 * kr * (1 - kr)) / kg),
      0,
    ),
    offset: Float32Array.of(full ? 0 : 16 / 255, 128 / 255, 128 / 255),
  };
  matrices.set(key, m);
  return m;
}

/** The planes of a frame as textures: format, size and the bytes per texel
 *  `UNPACK_ROW_LENGTH` counts a decoder's stride in. */
function planesOf(gl, format, width, height) {
  const cw = Math.ceil(width / 2);
  const ch = Math.ceil(height / 2);
  const r8 = { internal: gl.R8, format: gl.RED, texel: 1 };
  switch (format) {
    case 'NV12':
      return [
        { ...r8, width, height },
        { internal: gl.RG8, format: gl.RG, texel: 2, width: cw, height: ch },
      ];
    case 'I420':
      return [
        { ...r8, width, height },
        { ...r8, width: cw, height: ch },
        { ...r8, width: cw, height: ch },
      ];
    case 'BGRA':
      return [{ internal: gl.RGBA, format: gl.RGBA, texel: 4, width, height }];
  }
  return null;
}

/** One per GL device: the program, and the quad it draws. */
const programs = new WeakMap();

function programFor(gl) {
  let p = programs.get(gl);
  if (p) return p;
  const vs = compile(gl, gl.VERTEX_SHADER, VERT, 'video vertex');
  let fs;
  try {
    fs = compile(gl, gl.FRAGMENT_SHADER, FRAG, 'video fragment');
  } catch (err) {
    gl.deleteShader(vs);
    throw err;
  }
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  const linked = gl.getProgramParameter(program, gl.LINK_STATUS);
  const log = linked ? '' : gl.getProgramInfoLog(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!linked) {
    gl.deleteProgram(program);
    throw new Error(`video program failed to link: ${log}`);
  }
  const u = (name) => gl.getUniformLocation(program, name);
  const aPos = gl.getAttribLocation(program, 'aPos');
  const aUV = gl.getAttribLocation(program, 'aUV');
  // A strip over the whole target. The 2D context draws device row 0 at the
  // top of clip space, so the frame's first row — texture row 0 — goes
  // there: v = 0 at clip y = +1.
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    Float32Array.of(-1, 1, 0, 0, -1, -1, 0, 1, 1, 1, 1, 0, 1, -1, 1, 1),
    gl.STATIC_DRAW,
  );
  // its own vertex array, so the 2D contexts' attribute state — on the
  // default one, re-pointed every batch — is never this program's
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
  gl.enableVertexAttribArray(aUV);
  gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, 16, 8);
  gl.bindVertexArray(null);
  p = {
    program,
    buffer,
    vao,
    maxSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    loc: {
      uLayout: u('uLayout'),
      uY: u('uY'),
      uC: u('uC'),
      uV: u('uV'),
      uChroma: u('uChroma'),
      uMatrix: u('uMatrix'),
      uOffset: u('uOffset'),
    },
  };
  programs.set(gl, p);
  return p;
}

/** Each surface's plane textures, kept across frames of one size. */
const uploads = new WeakMap();

function texturesFor(gl, surface, format, width, height) {
  let kept = uploads.get(surface);
  if (
    kept &&
    kept.format === format &&
    kept.width === width &&
    kept.height === height
  ) {
    return kept;
  }
  if (kept) deleteTextures(gl, kept);
  const planes = planesOf(gl, format, width, height);
  kept = {
    format,
    width,
    height,
    planes,
    textures: planes.map(() => gl.createTexture()),
    fresh: true,
  };
  uploads.set(surface, kept);
  return kept;
}

function deleteTextures(gl, kept) {
  for (const tex of kept.textures) gl.deleteTexture(tex);
  kept.textures = [];
}

/**
 * A plane's rows at a stride `UNPACK_ROW_LENGTH` cannot say — one that is
 * not a whole number of texels — packed tight. Every decoder pads to whole
 * pixels, so this is the case that should never come.
 */
function tight(data, stride, rowBytes, rows) {
  const out = new Uint8Array(rowBytes * rows);
  for (let r = 0; r < rows; r++) {
    out.set(data.subarray(r * stride, r * stride + rowBytes), r * rowBytes);
  }
  return out;
}

/**
 * `frame` from `sink` into `surface` (a WaylandSurface at the frame's size).
 * False — and the frame is converted in JavaScript instead — where the
 * surface is not one of this backend's, the app has no GL, or the frame is
 * larger than a texture can be.
 */
export function writeVideoFrame(app, surface, sink, frame) {
  const gl = app?.gl;
  const target = surface?.target;
  if (!gl || !target?.fbo || target.destroyed) return false;
  if (!(sink.format in LAYOUT)) return false;
  app.makeCurrent();
  const p = programFor(gl);
  if (sink.width > p.maxSize || sink.height > p.maxSize) return false;
  // Anything a context still has buffered is drawn first: one of its draws
  // may read this target, and must read the frame it was given (device.js).
  flushDevice(gl);
  const kept = texturesFor(gl, surface, sink.format, sink.width, sink.height);
  try {
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    kept.planes.forEach((plane, i) => {
      const rowBytes = plane.width * plane.texel;
      const stride = frame.strides[i];
      let data = frame.planes[i];
      let rowLength = 0;
      if (stride !== rowBytes) {
        if (stride % plane.texel === 0) rowLength = stride / plane.texel;
        else data = tight(data, stride, rowBytes, plane.height);
      }
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, rowLength);
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, kept.textures[i]);
      if (kept.fresh) {
        // Y and BGRA meet the target texel for texel; chroma is half size,
        // and read between its samples as a player reads it
        const filter = i === 0 ? gl.NEAREST : gl.LINEAR;
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          plane.internal,
          plane.width,
          plane.height,
          0,
          plane.format,
          gl.UNSIGNED_BYTE,
          data,
        );
      } else {
        gl.texSubImage2D(
          gl.TEXTURE_2D,
          0,
          0,
          0,
          plane.width,
          plane.height,
          plane.format,
          gl.UNSIGNED_BYTE,
          data,
        );
      }
    });
    kept.fresh = false;

    target.bind();
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.colorMask(true, true, true, true);
    gl.useProgram(p.program);
    const { loc } = p;
    gl.uniform1i(loc.uLayout, LAYOUT[sink.format]);
    gl.uniform1i(loc.uY, 0);
    gl.uniform1i(loc.uC, 1);
    gl.uniform1i(loc.uV, 2);
    // full-size texture coordinates onto a chroma plane rounded up: an odd
    // frame's last chroma column covers one picture column, not two
    gl.uniform2f(
      loc.uChroma,
      sink.width / (2 * Math.ceil(sink.width / 2)),
      sink.height / (2 * Math.ceil(sink.height / 2)),
    );
    const { matrix, offset } = videoMatrix(sink.colorSpace, sink.range);
    gl.uniformMatrix3fv(loc.uMatrix, false, matrix);
    gl.uniform3fv(loc.uOffset, offset);
    gl.bindVertexArray(p.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  } finally {
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.activeTexture(gl.TEXTURE0);
    // the program, the blend and the framebuffer were the 2D contexts' to
    // say: the next one to draw says them again
    releaseDevice(gl);
    app.rebindWindowTarget?.();
  }
  return true;
}

/** `surface` is let go: its plane textures with it. */
export function releaseVideoFrame(app, surface) {
  const kept = uploads.get(surface);
  if (!kept) return;
  uploads.delete(surface);
  const gl = app?.gl;
  if (!gl) return;
  app.makeCurrent();
  deleteTextures(gl, kept);
}

function compile(gl, type, src, what) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`${what} shader failed to compile: ${log}`);
  }
  return sh;
}

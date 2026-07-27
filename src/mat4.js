// 4x4 matrices in OpenGL's column-major order, as Float32Array(16) — the
// layout MultMatrixf/LoadMatrixf expect on the wire, so nothing is
// transposed on the way out.

export function identity() {
  // prettier-ignore
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

/** out = a * b (apply b first, then a — same convention as GL). */
export function multiply(a, b, out = new Float32Array(16)) {
  for (let col = 0; col < 4; col++) {
    const b0 = b[col * 4];
    const b1 = b[col * 4 + 1];
    const b2 = b[col * 4 + 2];
    const b3 = b[col * 4 + 3];
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] =
        a[row] * b0 + a[4 + row] * b1 + a[8 + row] * b2 + a[12 + row] * b3;
    }
  }
  return out;
}

/**
 * Compose position / euler rotation (XYZ order, radians) / scale into a
 * transform, the same order three.js uses: T * Rx * Ry * Rz * S.
 */
export function compose(position, rotation, scale, out = new Float32Array(16)) {
  const [px, py, pz] = position;
  const [rx, ry, rz] = rotation;
  const [sx, sy, sz] = scale;
  const cx = Math.cos(rx);
  const sxr = Math.sin(rx);
  const cy = Math.cos(ry);
  const syr = Math.sin(ry);
  const cz = Math.cos(rz);
  const szr = Math.sin(rz);

  // rotation matrix for the XYZ euler order
  const r00 = cy * cz;
  const r01 = -cy * szr;
  const r02 = syr;
  const r10 = sxr * syr * cz + cx * szr;
  const r11 = -sxr * syr * szr + cx * cz;
  const r12 = -sxr * cy;
  const r20 = -cx * syr * cz + sxr * szr;
  const r21 = cx * syr * szr + sxr * cz;
  const r22 = cx * cy;

  out[0] = r00 * sx;
  out[1] = r10 * sx;
  out[2] = r20 * sx;
  out[3] = 0;
  out[4] = r01 * sy;
  out[5] = r11 * sy;
  out[6] = r21 * sy;
  out[7] = 0;
  out[8] = r02 * sz;
  out[9] = r12 * sz;
  out[10] = r22 * sz;
  out[11] = 0;
  out[12] = px;
  out[13] = py;
  out[14] = pz;
  out[15] = 1;
  return out;
}

/** Perspective projection; `fov` is the vertical field of view in degrees. */
export function perspective(
  fov,
  aspect,
  near,
  far,
  out = new Float32Array(16),
) {
  const f = 1 / Math.tan((fov * Math.PI) / 360);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
  return out;
}

export function orthographic(
  left,
  right,
  bottom,
  top,
  near,
  far,
  out = new Float32Array(16),
) {
  out.fill(0);
  out[0] = 2 / (right - left);
  out[5] = 2 / (top - bottom);
  out[10] = -2 / (far - near);
  out[12] = -(right + left) / (right - left);
  out[13] = -(top + bottom) / (top - bottom);
  out[14] = -(far + near) / (far - near);
  out[15] = 1;
  return out;
}

function normalize(v) {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/** View matrix for a camera at `eye` looking at `target`. */
export function lookAt(
  eye,
  target,
  up = [0, 1, 0],
  out = new Float32Array(16),
) {
  const z = normalize([
    eye[0] - target[0],
    eye[1] - target[1],
    eye[2] - target[2],
  ]);
  let x = cross(up, z);
  if (Math.hypot(x[0], x[1], x[2]) < 1e-6) {
    // up is parallel to the view direction: nudge it so the basis stays sane
    x = cross([up[0] + 1e-4, up[1], up[2] + 1e-4], z);
  }
  x = normalize(x);
  const y = cross(z, x);

  out[0] = x[0];
  out[1] = y[0];
  out[2] = z[0];
  out[3] = 0;
  out[4] = x[1];
  out[5] = y[1];
  out[6] = z[1];
  out[7] = 0;
  out[8] = x[2];
  out[9] = y[2];
  out[10] = z[2];
  out[11] = 0;
  out[12] = -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2]);
  out[13] = -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]);
  out[14] = -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]);
  out[15] = 1;
  return out;
}

// Geometry generators for the primitive `<*Geometry>` elements. Each takes
// the same `args` tuple as its three.js counterpart and returns plain
// arrays — positions, normals, uvs and a triangle index — which the display
// list compiler turns into one server-side list (src/scene3d.js).

/**
 * Build a parametric surface as a (segmentsX+1) x (segmentsY+1) vertex grid.
 * `point(u, v)` returns [position, normal] for u, v in 0..1.
 */
function grid(segmentsX, segmentsY, point) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const index = [];
  for (let iy = 0; iy <= segmentsY; iy++) {
    for (let ix = 0; ix <= segmentsX; ix++) {
      const u = ix / segmentsX;
      const v = iy / segmentsY;
      const [p, n] = point(u, v);
      positions.push(p[0], p[1], p[2]);
      normals.push(n[0], n[1], n[2]);
      uvs.push(u, 1 - v);
    }
  }
  const stride = segmentsX + 1;
  for (let iy = 0; iy < segmentsY; iy++) {
    for (let ix = 0; ix < segmentsX; ix++) {
      const a = iy * stride + ix;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      index.push(a, c, b, b, c, d);
    }
  }
  return { positions, normals, uvs, index };
}

function merge(parts) {
  const out = { positions: [], normals: [], uvs: [], index: [] };
  for (const part of parts) {
    const offset = out.positions.length / 3;
    out.positions.push(...part.positions);
    out.normals.push(...part.normals);
    out.uvs.push(...part.uvs);
    for (const i of part.index) out.index.push(i + offset);
  }
  return out;
}

export function planeGeometry([width = 1, height = 1, ws = 1, hs = 1] = []) {
  return grid(ws, hs, (u, v) => [
    [(u - 0.5) * width, (0.5 - v) * height, 0],
    [0, 0, 1],
  ]);
}

export function boxGeometry([
  width = 1,
  height = 1,
  depth = 1,
  ws = 1,
  hs = 1,
  ds = 1,
] = []) {
  // one grid per face, oriented by (right, up, normal) basis vectors
  const face = (right, up, normal, w, h, segU, segV, offset) =>
    grid(segU, segV, (u, v) => {
      const su = (u - 0.5) * w;
      const sv = (0.5 - v) * h;
      return [
        [
          right[0] * su + up[0] * sv + normal[0] * offset,
          right[1] * su + up[1] * sv + normal[1] * offset,
          right[2] * su + up[2] * sv + normal[2] * offset,
        ],
        normal,
      ];
    });

  const x = width / 2;
  const y = height / 2;
  const z = depth / 2;
  return merge([
    face([0, 0, 1], [0, 1, 0], [-1, 0, 0], depth, height, ds, hs, x), // -x
    face([0, 0, -1], [0, 1, 0], [1, 0, 0], depth, height, ds, hs, x), // +x
    face([1, 0, 0], [0, 0, -1], [0, 1, 0], width, depth, ws, ds, y), // +y
    face([1, 0, 0], [0, 0, 1], [0, -1, 0], width, depth, ws, ds, y), // -y
    face([-1, 0, 0], [0, 1, 0], [0, 0, -1], width, height, ws, hs, z), // -z
    face([1, 0, 0], [0, 1, 0], [0, 0, 1], width, height, ws, hs, z), // +z
  ]);
}

export function sphereGeometry([radius = 1, ws = 32, hs = 16] = []) {
  return grid(ws, hs, (u, v) => {
    const theta = u * Math.PI * 2;
    const phi = v * Math.PI;
    const n = [
      -Math.sin(phi) * Math.cos(theta),
      Math.cos(phi),
      Math.sin(phi) * Math.sin(theta),
    ];
    return [[n[0] * radius, n[1] * radius, n[2] * radius], n];
  });
}

export function cylinderGeometry([
  radiusTop = 1,
  radiusBottom = 1,
  height = 1,
  radialSegments = 32,
  heightSegments = 1,
  openEnded = false,
] = []) {
  const half = height / 2;
  const slope = (radiusBottom - radiusTop) / height;
  const side = grid(radialSegments, heightSegments, (u, v) => {
    const theta = u * Math.PI * 2;
    const radius = radiusTop + (radiusBottom - radiusTop) * v;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const len = Math.hypot(1, slope) || 1;
    return [
      [radius * sin, half - v * height, radius * cos],
      [sin / len, slope / len, cos / len],
    ];
  });
  if (openEnded) return side;

  // caps: a triangle fan around the centre, expressed as a 1-segment grid
  const cap = (radius, y, dir) =>
    grid(radialSegments, 1, (u, v) => {
      const theta = u * Math.PI * 2 * dir;
      const r = v * radius;
      return [
        [r * Math.sin(theta), y, r * Math.cos(theta)],
        [0, dir, 0],
      ];
    });
  const parts = [side];
  if (radiusTop > 0) parts.push(cap(radiusTop, half, 1));
  if (radiusBottom > 0) parts.push(cap(radiusBottom, -half, -1));
  return merge(parts);
}

export function torusGeometry([
  radius = 1,
  tube = 0.4,
  radialSegments = 12,
  tubularSegments = 48,
] = []) {
  return grid(tubularSegments, radialSegments, (u, v) => {
    const theta = u * Math.PI * 2;
    const phi = v * Math.PI * 2;
    const cx = radius * Math.cos(theta);
    const cz = radius * Math.sin(theta);
    const n = [
      Math.cos(theta) * Math.cos(phi),
      Math.sin(phi),
      Math.sin(theta) * Math.cos(phi),
    ];
    return [[cx + tube * n[0], tube * n[1], cz + tube * n[2]], n];
  });
}

export const GEOMETRY_BUILDERS = {
  boxGeometry,
  planeGeometry,
  sphereGeometry,
  cylinderGeometry,
  torusGeometry,
};

/** `<bufferGeometry position={…} normal={…} uv={…} index={…} />` */
export function bufferGeometry(props) {
  const positions = props.position ?? props.positions ?? [];
  const count = positions.length / 3;
  let normals = props.normal ?? props.normals;
  const index = props.index ?? null;
  if (!normals) normals = faceNormals(positions, index, count);
  return {
    positions,
    normals,
    uvs: props.uv ?? props.uvs ?? new Array(count * 2).fill(0),
    index,
  };
}

/** Flat normals from the triangles themselves, averaged per vertex. */
function faceNormals(positions, index, count) {
  const normals = new Array(count * 3).fill(0);
  const tri = index ?? Array.from({ length: count }, (_, i) => i);
  for (let i = 0; i + 2 < tri.length; i += 3) {
    const [a, b, c] = [tri[i], tri[i + 1], tri[i + 2]];
    const ax = positions[a * 3];
    const ay = positions[a * 3 + 1];
    const az = positions[a * 3 + 2];
    const ux = positions[b * 3] - ax;
    const uy = positions[b * 3 + 1] - ay;
    const uz = positions[b * 3 + 2] - az;
    const vx = positions[c * 3] - ax;
    const vy = positions[c * 3 + 1] - ay;
    const vz = positions[c * 3 + 2] - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    for (const v of [a, b, c]) {
      normals[v * 3] += nx;
      normals[v * 3 + 1] += ny;
      normals[v * 3 + 2] += nz;
    }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]);
    if (len > 0) {
      normals[i] /= len;
      normals[i + 1] /= len;
      normals[i + 2] /= len;
    } else {
      normals[i + 1] = 1;
    }
  }
  return normals;
}

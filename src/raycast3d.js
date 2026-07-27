// Client-side picking for the 3D scene.
//
// There is no GPU picking here: reading pixels back over the protocol is a
// round trip per event, and on XQuartz GL output is not even readable
// through GetImage. So the ray is cast against the CPU-side geometry — the
// same arrays the display lists were compiled from — the way three.js does
// it. Only meshes that (or whose ancestors) have pointer handlers take part,
// which is r3f's one optimization that matters.
import {
  invert,
  multiply,
  transformDirection,
  transformPoint,
} from './mat4.js';

const EPSILON = 1e-8;

function normalize([x, y, z]) {
  const len = Math.hypot(x, y, z) || 1;
  return [x / len, y / len, z / len];
}

/**
 * Möller–Trumbore. Returns the ray parameter at the intersection, or null.
 * `dir` need not be unit length: `t` is then in the same units as `dir`,
 * which is what keeps object-space hits comparable in world space.
 */
function intersectTriangle(origin, dir, a, b, c) {
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const p = [
    dir[1] * e2[2] - dir[2] * e2[1],
    dir[2] * e2[0] - dir[0] * e2[2],
    dir[0] * e2[1] - dir[1] * e2[0],
  ];
  const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
  if (Math.abs(det) < EPSILON) return null;
  const inv = 1 / det;
  const t0 = [origin[0] - a[0], origin[1] - a[1], origin[2] - a[2]];
  const u = (t0[0] * p[0] + t0[1] * p[1] + t0[2] * p[2]) * inv;
  if (u < 0 || u > 1) return null;
  const q = [
    t0[1] * e1[2] - t0[2] * e1[1],
    t0[2] * e1[0] - t0[0] * e1[2],
    t0[0] * e1[1] - t0[1] * e1[0],
  ];
  const v = (dir[0] * q[0] + dir[1] * q[1] + dir[2] * q[2]) * inv;
  if (v < 0 || u + v > 1) return null;
  const t = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * inv;
  return t > EPSILON ? { t, u, v } : null;
}

/**
 * The world-space ray through a pixel of the surface.
 * @returns {{origin: number[], direction: number[]}}
 */
export function rayThrough(x, y, { width, height, projection, view }) {
  const inverse = invert(multiply(projection, view));
  if (!inverse) return null;
  const ndcX = (2 * x) / width - 1;
  const ndcY = 1 - (2 * y) / height;
  const near = transformPoint(inverse, [ndcX, ndcY, -1]);
  const far = transformPoint(inverse, [ndcX, ndcY, 1]);
  return {
    origin: near,
    direction: normalize([
      far[0] - near[0],
      far[1] - near[1],
      far[2] - near[2],
    ]),
  };
}

const POINTER_PROPS = [
  'onClick',
  'onPointerDown',
  'onPointerUp',
  'onPointerMove',
  'onPointerOver',
  'onPointerOut',
];

export const hasPointerHandlers = (node) =>
  POINTER_PROPS.some((name) => typeof node.props?.[name] === 'function');

/** Meshes worth testing: they, or an ancestor, listen for pointer events. */
function pickable(nodes, inherited, out = []) {
  for (const node of nodes) {
    if (!node.isObject3D || !node.visible) continue;
    const listening = inherited || hasPointerHandlers(node);
    if (listening && node.kind === 'mesh' && node.geometry) out.push(node);
    pickable(node.children, listening, out);
  }
  return out;
}

/**
 * Intersect the scene under `surface` with the ray through pixel (x, y).
 * `world` matrices come from the last rendered frame.
 * @returns {Array<{object, distance, point, face}>} nearest first
 */
export function raycast(surface, x, y, camera) {
  const ray = rayThrough(x, y, camera);
  if (!ray) return [];
  const hits = [];

  for (const mesh of pickable(surface.children, false)) {
    const world = mesh._world;
    const toObject = world ? invert(world) : null;
    if (!toObject) continue;
    const origin = transformPoint(toObject, ray.origin);
    const direction = transformDirection(toObject, ray.direction);
    const { positions, index } = mesh.geometry.data();
    const count = index ? index.length : positions.length / 3;
    const vertex = (i) => {
      const v = index ? index[i] : i;
      return [positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]];
    };

    let best = null;
    for (let i = 0; i + 2 < count; i += 3) {
      const hit = intersectTriangle(
        origin,
        direction,
        vertex(i),
        vertex(i + 1),
        vertex(i + 2),
      );
      if (hit && (!best || hit.t < best.t)) best = { ...hit, face: i / 3 };
    }
    if (!best) continue;
    hits.push({
      object: mesh,
      distance: best.t,
      point: [
        ray.origin[0] + ray.direction[0] * best.t,
        ray.origin[1] + ray.direction[1] * best.t,
        ray.origin[2] + ray.direction[2] * best.t,
      ],
      face: best.face,
      uv: [best.u, best.v],
    });
  }

  return hits.sort((a, b) => a.distance - b.distance);
}

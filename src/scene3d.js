// The 3D scene tree: `<mesh>`, `<group>`, geometries and materials living
// inside a `<glarea>`, drawn through indirect GLX (docs/glx-plan.md).
//
// It is deliberately separate from the 2D drawn tree — no yoga, no painting
// into the parent's 2d context. The rule that shapes everything here is a
// protocol one: GLX encodes no vertex arrays, so geometry can only travel as
// immediate-mode commands. Sending a mesh per frame costs kilobytes per
// frame, so every geometry is compiled into a **server-side display list**
// once and replayed with a single CallList. A frame is then matrices +
// material state + one CallList per mesh, whatever the triangle count.
import { cssColor } from 'ntk';

import {
  GEOMETRY_BUILDERS,
  bufferGeometry as buildBufferGeometry,
} from './geometry3d.js';
import {
  compose,
  identity,
  lookAt,
  multiply,
  orthographic,
  perspective,
} from './mat4.js';
import { Node } from './nodes.js';
import { hasPointerHandlers } from './raycast3d.js';

export const GEOMETRY_KINDS = new Set([
  ...Object.keys(GEOMETRY_BUILDERS),
  'bufferGeometry',
]);
export const MATERIAL_KINDS = new Set([
  'meshBasicMaterial',
  'meshLambertMaterial',
  'meshPhongMaterial',
]);
export const LIGHT_KINDS = new Set([
  'ambientLight',
  'directionalLight',
  'pointLight',
  'spotLight',
]);
export const OBJECT_KINDS = new Set(['mesh', 'group', ...LIGHT_KINDS]);
export const SCENE_KINDS = new Set([
  ...GEOMETRY_KINDS,
  ...MATERIAL_KINDS,
  ...OBJECT_KINDS,
]);

// fixed-function GL has exactly eight light units
const MAX_LIGHTS = 8;

/**
 * react-three-fiber names that indirect GLX cannot implement — the protocol
 * encodes no shaders, no framebuffer objects and no instancing, so these
 * fail loudly instead of rendering something that only looks right.
 */
export const UNSUPPORTED_KINDS = {
  shaderMaterial: 'GLSL shaders: the GLX protocol encodes no shader objects',
  rawShaderMaterial: 'GLSL shaders: the GLX protocol encodes no shader objects',
  instancedMesh: 'instancing: no vertex arrays or instanced draw commands',
  points: 'point clouds need vertex arrays, which GLX does not encode',
  line: 'line geometry needs vertex arrays, which GLX does not encode',
  effectComposer: 'post-processing needs framebuffer objects',
};

const asTriple = (value, fallback) => {
  if (value == null) return fallback;
  if (typeof value === 'number') return [value, value, value];
  return [value[0] ?? 0, value[1] ?? 0, value[2] ?? 0];
};

/** Base for anything with a transform: `<mesh>`, `<group>`. */
export class Object3DNode extends Node {
  constructor(kind, props, app) {
    super(kind, props, app, { yoga: false });
    this.surface = null; // owning GlAreaNode
    this._matrix = identity();
    this._matrixDirty = true;
  }

  get isObject3D() {
    return true;
  }

  /** scene nodes are not part of the 2D tree; they follow the surface. */
  _setRoot() {}

  _setSurface(surface) {
    if (this.surface === surface) return;
    this.surface = surface;
    for (const child of this.children) child._setSurface?.(surface);
  }

  insertBefore(child, beforeChild) {
    super.insertBefore(child, beforeChild);
    child._setSurface?.(this.surface);
    this.surface?._sceneChanged?.();
  }

  removeChild(child) {
    super.removeChild(child);
    this.surface?.invalidateGeometry?.(child);
    this.surface?.pointer?.forget(child);
    this.surface?._sceneChanged?.();
  }

  applyProps(newProps) {
    const before = this.props;
    this.props = newProps;
    this._matrixDirty = true;
    // gaining or losing handlers changes whether the surface needs X
    // pointer events at all
    if (hasPointerHandlers({ props: before }) !== hasPointerHandlers(this)) {
      this.surface?._sceneChanged?.();
    } else {
      this.surface?.requestFrame();
    }
  }

  setHidden(hidden) {
    this.hidden = hidden;
    this.surface?.requestFrame();
  }

  localMatrix() {
    if (this._matrixDirty) {
      const p = this.props;
      compose(
        asTriple(p.position, [0, 0, 0]),
        asTriple(p.rotation, [0, 0, 0]),
        asTriple(p.scale, [1, 1, 1]),
        this._matrix,
      );
      this._matrixDirty = false;
    }
    return this._matrix;
  }

  get visible() {
    return !this.hidden && this.props.visible !== false;
  }
}

export class MeshNode extends Object3DNode {
  constructor(props, app) {
    super('mesh', props, app);
  }

  get geometry() {
    return this.children.find((c) => c.isGeometry) ?? null;
  }

  get material() {
    return this.children.find((c) => c.isMaterial) ?? null;
  }
}

export class GroupNode extends Object3DNode {
  constructor(props, app) {
    super('group', props, app);
  }
}

/** `<pointLight position={[4, 5, 3]} intensity={1} />` and friends. */
export class LightNode extends Object3DNode {
  constructor(kind, props, app) {
    super(kind, props, app);
  }

  get isLight() {
    return true;
  }
}

/** `<boxGeometry args={[1, 1, 1]} />`, `<bufferGeometry position={…} />` */
export class GeometryNode extends Object3DNode {
  constructor(kind, props, app) {
    super(kind, props, app);
    this.version = 0;
    this._data = null;
  }

  get isObject3D() {
    return false;
  }

  get isGeometry() {
    return true;
  }

  applyProps(newProps) {
    const before = this.props;
    this.props = newProps;
    if (!sameGeometryProps(before, newProps)) {
      // a new shape: drop the cached arrays and the server-side list
      this._data = null;
      this.version++;
    }
    this.surface?.requestFrame();
  }

  /** { positions, normals, uvs, index } — memoized per prop version. */
  data() {
    if (!this._data) {
      const build = GEOMETRY_BUILDERS[this.kind];
      this._data = build
        ? build(this.props.args ?? [])
        : buildBufferGeometry(this.props);
    }
    return this._data;
  }
}

function sameGeometryProps(a, b) {
  if (a === b) return true;
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const key of keys) {
    const av = a?.[key];
    const bv = b?.[key];
    if (av === bv) continue;
    if (Array.isArray(av) && Array.isArray(bv)) {
      if (av.length !== bv.length || av.some((v, i) => v !== bv[i]))
        return false;
      continue;
    }
    return false;
  }
  return true;
}

/** `<meshBasicMaterial color="#2980b9" wireframe />` */
export class MaterialNode extends Object3DNode {
  constructor(kind, props, app) {
    super(kind, props, app);
  }

  get isObject3D() {
    return false;
  }

  get isMaterial() {
    return true;
  }
}

export function createSceneNode(kind, props, app) {
  if (kind === 'mesh') return new MeshNode(props, app);
  if (kind === 'group') return new GroupNode(props, app);
  if (LIGHT_KINDS.has(kind)) return new LightNode(kind, props, app);
  if (GEOMETRY_KINDS.has(kind)) return new GeometryNode(kind, props, app);
  if (MATERIAL_KINDS.has(kind)) return new MaterialNode(kind, props, app);
  return null;
}

// ---------------------------------------------------------------------------
// rendering

const DEFAULT_CAMERA = {
  position: [0, 0, 5],
  target: [0, 0, 0],
  up: [0, 1, 0],
  fov: 50,
  near: 0.1,
  far: 1000,
  zoom: 1,
};

export function cameraMatrices(spec, { width, height }) {
  const camera = { ...DEFAULT_CAMERA, ...spec };
  const aspect = width / Math.max(1, height);
  const projection = camera.orthographic
    ? orthographic(
        -aspect / camera.zoom,
        aspect / camera.zoom,
        -1 / camera.zoom,
        1 / camera.zoom,
        camera.near,
        camera.far,
      )
    : perspective(camera.fov, aspect, camera.near, camera.far);
  return {
    projection,
    view: lookAt(camera.position, camera.target, camera.up),
  };
}

const rgba = (color, fallback = [1, 1, 1, 1]) => {
  if (!color) return fallback;
  if (Array.isArray(color)) return color.length === 4 ? color : [...color, 1];
  return cssColor(color) ?? fallback;
};

/** Lights with their world matrices, in tree order. */
function collectLights(nodes, parentMatrix, out = []) {
  for (const node of nodes) {
    if (!node.isObject3D || !node.visible) continue;
    const world = multiply(parentMatrix, node.localMatrix());
    if (node.isLight) out.push({ node, world });
    collectLights(node.children, world, out);
  }
  return out;
}

const scaled = ([r, g, b], intensity) => [
  r * intensity,
  g * intensity,
  b * intensity,
  1,
];

/**
 * Per-surface GL bookkeeping: the display list of every geometry, and the
 * material state last sent (so an unchanged material costs nothing).
 */
export class SceneRenderer {
  constructor(surface) {
    this.surface = surface;
    this.lists = new Map(); // GeometryNode -> { id, version }
    this.nextList = 1;
    this.materialKey = null;
    this.initialized = false;
    this.enabledLights = 0;
    this.lit = false;
    this.warnedLightLimit = false;
  }

  /** Draw the scene under `surface`; false when there is nothing 3D to draw. */
  render(gl, info) {
    const roots = this.surface.children.filter((c) => c.isObject3D);
    if (roots.length === 0) return false;

    if (!this.initialized) {
      this.initialized = true;
      gl.Enable(gl.DEPTH_TEST);
      gl.Enable(gl.NORMALIZE); // scaled meshes keep unit-length normals
      gl.ShadeModel(gl.SMOOTH);
    }
    this.materialKey = null;

    const { projection, view } = cameraMatrices(
      this.surface.props.camera,
      info,
    );
    // kept for picking: rays are cast against the frame that is on screen
    this.camera = { projection, view, width: info.width, height: info.height };
    gl.MatrixMode(gl.PROJECTION);
    gl.LoadIdentity();
    gl.MultMatrixf(projection);
    gl.MatrixMode(gl.MODELVIEW);
    gl.LoadIdentity();
    gl.MultMatrixf(view);

    // light positions are transformed by the modelview matrix in force when
    // they are sent, and it is the view matrix right now — so world-space
    // positions land in eye space exactly as GL expects
    this.applyLights(gl, collectLights(roots, identity()));

    for (const node of roots) this.drawObject(gl, node, identity());
    return true;
  }

  drawObject(gl, node, parentWorld) {
    if (!node.visible) return;
    // the world matrix is recorded rather than recomputed later: picking
    // rays are transformed by exactly what was drawn
    const world = multiply(parentWorld, node.localMatrix());
    node._world = world;
    gl.PushMatrix();
    gl.MultMatrixf(node.localMatrix());
    if (node.kind === 'mesh') this.drawMesh(gl, node);
    for (const child of node.children) {
      if (child.isObject3D) this.drawObject(gl, child, world);
    }
    gl.PopMatrix();
  }

  drawMesh(gl, mesh) {
    const geometry = mesh.geometry;
    if (!geometry) return;
    this.applyMaterial(gl, mesh.material);
    gl.CallList(this.listFor(gl, geometry));
  }

  /** Compile once, replay forever — this is the whole point of the design. */
  listFor(gl, geometry) {
    const cached = this.lists.get(geometry);
    if (cached && cached.version === geometry.version) return cached.id;
    const id = cached ? cached.id : this.nextList++;
    const { positions, normals, uvs, index } = geometry.data();
    const count = index ? index.length : positions.length / 3;

    gl.NewList(id, gl.COMPILE);
    gl.Begin(gl.TRIANGLES);
    for (let i = 0; i < count; i++) {
      const v = index ? index[i] : i;
      if (normals && normals.length > v * 3 + 2) {
        gl.Normal3f(normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2]);
      }
      if (uvs && uvs.length > v * 2 + 1) {
        gl.TexCoord2f(uvs[v * 2], uvs[v * 2 + 1]);
      }
      gl.Vertex3f(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
    }
    gl.End();
    gl.EndList();

    this.lists.set(geometry, { id, version: geometry.version });
    return id;
  }

  /**
   * Fixed-function GL has eight light units. `<ambientLight>` has no unit of
   * its own — its colour is summed into the first light's GL_AMBIENT term
   * (and into a dummy unit when it is the only light in the scene).
   */
  applyLights(gl, lights) {
    let ambient = [0, 0, 0];
    const units = [];
    for (const light of lights) {
      const { node } = light;
      const intensity = node.props.intensity ?? 1;
      const [r, g, b] = rgba(node.props.color, [1, 1, 1, 1]);
      if (node.kind === 'ambientLight') {
        ambient = [
          ambient[0] + r * intensity,
          ambient[1] + g * intensity,
          ambient[2] + b * intensity,
        ];
        continue;
      }
      units.push({ node, intensity, color: [r, g, b] });
    }

    if (units.length > MAX_LIGHTS && !this.warnedLightLimit) {
      this.warnedLightLimit = true;
      console.warn(
        `react-x11: ${units.length} lights in the scene; fixed-function GL ` +
          `has ${MAX_LIGHTS} light units, so the rest are ignored.`,
      );
    }
    const used = units.slice(0, MAX_LIGHTS);
    this.lit = used.length > 0 || ambient.some((c) => c > 0);

    if (!this.lit) {
      for (let i = 0; i < this.enabledLights; i++) gl.Disable(gl.LIGHT0 + i);
      this.enabledLights = 0;
      return;
    }

    // ambient-only scenes still need one unit, to carry the ambient term
    const count = Math.max(used.length, 1);
    for (let i = 0; i < count; i++) {
      const unit = gl.LIGHT0 + i;
      gl.Enable(unit);
      gl.Lightfv(unit, gl.AMBIENT, i === 0 ? [...ambient, 1] : [0, 0, 0, 1]);
      const light = used[i];
      if (!light) {
        // the dummy unit for a scene lit only by <ambientLight>
        gl.Lightfv(unit, gl.DIFFUSE, [0, 0, 0, 1]);
        gl.Lightfv(unit, gl.SPECULAR, [0, 0, 0, 1]);
        gl.Lightfv(unit, gl.POSITION, [0, 0, 1, 0]);
        continue;
      }
      const { node, intensity, color } = light;
      const world = lights.find((l) => l.node === node).world;
      const position = [world[12], world[13], world[14]];
      gl.Lightfv(unit, gl.DIFFUSE, scaled(color, intensity));
      gl.Lightfv(
        unit,
        gl.SPECULAR,
        scaled(color, node.props.specular === false ? 0 : intensity),
      );

      if (node.kind === 'directionalLight') {
        // w = 0: a direction, pointing from the scene toward the light
        gl.Lightfv(unit, gl.POSITION, [...position, 0]);
        gl.Lightfv(unit, gl.SPOT_DIRECTION, [0, 0, -1, 0]);
        gl.Lightfv(unit, gl.SPOT_CUTOFF, 180, 0, 0, 0);
      } else {
        gl.Lightfv(unit, gl.POSITION, [...position, 1]);
        const distance = node.props.distance ?? 0;
        // three.js decay=2 is physical falloff; map it onto GL attenuation
        const decay = node.props.decay ?? 0;
        gl.Lightfv(unit, gl.CONSTANT_ATTENUATION, 1, 0, 0, 0);
        gl.Lightfv(
          unit,
          gl.LINEAR_ATTENUATION,
          distance > 0 ? 1 / distance : 0,
          0,
          0,
          0,
        );
        gl.Lightfv(
          unit,
          gl.QUADRATIC_ATTENUATION,
          decay > 1 && distance > 0 ? 1 / (distance * distance) : 0,
          0,
          0,
          0,
        );
        if (node.kind === 'spotLight') {
          const target = node.props.target ?? [0, 0, 0];
          const dir = [
            target[0] - position[0],
            target[1] - position[1],
            target[2] - position[2],
          ];
          const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
          gl.Lightfv(
            unit,
            gl.SPOT_DIRECTION,
            dir[0] / len,
            dir[1] / len,
            dir[2] / len,
            0,
          );
          const angle = node.props.angle ?? Math.PI / 6;
          gl.Lightfv(
            unit,
            gl.SPOT_CUTOFF,
            Math.min(90, (angle * 180) / Math.PI),
            0,
            0,
            0,
          );
          gl.Lightfv(
            unit,
            gl.SPOT_EXPONENT,
            (node.props.penumbra ?? 0) * 128,
            0,
            0,
            0,
          );
        } else {
          gl.Lightfv(unit, gl.SPOT_CUTOFF, 180, 0, 0, 0);
        }
      }
    }
    for (let i = count; i < this.enabledLights; i++) gl.Disable(gl.LIGHT0 + i);
    this.enabledLights = count;
    // the material state depends on whether lighting is on
    this.materialKey = null;
  }

  /** Material state is per frame, so one geometry list can serve many meshes. */
  applyMaterial(gl, material) {
    const kind = material?.kind ?? 'meshBasicMaterial';
    const props = material?.props ?? {};
    const [r, g, b, a] = rgba(props.color);
    const opacity = props.opacity ?? 1;
    const alpha = a * opacity;
    // <meshBasicMaterial> is unlit by definition, and a lit material with no
    // light in the scene would render black — fall back to flat colour
    const lit = kind !== 'meshBasicMaterial' && this.lit;
    const key = [
      kind,
      lit,
      r,
      g,
      b,
      alpha,
      props.wireframe,
      props.side,
      props.transparent,
      props.shininess,
      props.specular,
      props.emissive,
    ].join('|');
    if (key === this.materialKey) return;
    this.materialKey = key;

    const blended = alpha < 1 || props.transparent;
    if (blended) {
      gl.Enable(gl.BLEND);
      gl.BlendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    } else {
      gl.Disable(gl.BLEND);
    }

    if (lit) {
      gl.Enable(gl.LIGHTING);
      // colour reaches the shading equation as the surface reflectance
      gl.Materialfv(gl.FRONT_AND_BACK, gl.AMBIENT_AND_DIFFUSE, [
        r,
        g,
        b,
        alpha,
      ]);
      gl.Materialfv(
        gl.FRONT_AND_BACK,
        gl.EMISSION,
        rgba(props.emissive, [0, 0, 0, 1]),
      );
      if (kind === 'meshPhongMaterial') {
        gl.Materialfv(
          gl.FRONT_AND_BACK,
          gl.SPECULAR,
          rgba(props.specular, [1, 1, 1, 1]),
        );
        gl.Materialf(gl.FRONT_AND_BACK, gl.SHININESS, props.shininess ?? 30);
      } else {
        // Lambert: diffuse only
        gl.Materialfv(gl.FRONT_AND_BACK, gl.SPECULAR, [0, 0, 0, 1]);
        gl.Materialf(gl.FRONT_AND_BACK, gl.SHININESS, 0);
      }
      // both faces are shaded when both are drawn
      gl.LightModelf(gl.LIGHT_MODEL_TWO_SIDE, props.side === 'double' ? 1 : 0);
    } else {
      gl.Disable(gl.LIGHTING);
      if (blended) gl.Color4f(r, g, b, alpha);
      else gl.Color3f(r, g, b);
    }

    gl.PolygonMode(gl.FRONT_AND_BACK, props.wireframe ? gl.LINE : gl.FILL);
    if (props.side === 'double') {
      gl.Disable(gl.CULL_FACE);
    } else {
      gl.Enable(gl.CULL_FACE);
      gl.CullFace(props.side === 'back' ? gl.FRONT : gl.BACK);
    }
  }

  /** Drop a removed geometry's list so the id can be reused. */
  forget(gl, node) {
    const entry = this.lists.get(node);
    if (!entry) return;
    this.lists.delete(node);
    gl?.DeleteLists?.(entry.id, 1);
  }

  dispose(gl) {
    for (const { id } of this.lists.values()) gl?.DeleteLists?.(id, 1);
    this.lists.clear();
  }
}

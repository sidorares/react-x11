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
  orthographic,
  perspective,
} from './mat4.js';
import { Node } from './nodes.js';

export const GEOMETRY_KINDS = new Set([
  ...Object.keys(GEOMETRY_BUILDERS),
  'bufferGeometry',
]);
export const MATERIAL_KINDS = new Set([
  'meshBasicMaterial',
  'meshLambertMaterial',
  'meshPhongMaterial',
]);
export const OBJECT_KINDS = new Set(['mesh', 'group']);
export const SCENE_KINDS = new Set([
  ...GEOMETRY_KINDS,
  ...MATERIAL_KINDS,
  ...OBJECT_KINDS,
]);

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
    this.surface?.requestFrame();
  }

  removeChild(child) {
    super.removeChild(child);
    this.surface?.invalidateGeometry?.(child);
    this.surface?.requestFrame();
  }

  applyProps(newProps) {
    this.props = newProps;
    this._matrixDirty = true;
    this.surface?.requestFrame();
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

function cameraMatrices(spec, { width, height }) {
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
    gl.MatrixMode(gl.PROJECTION);
    gl.LoadIdentity();
    gl.MultMatrixf(projection);
    gl.MatrixMode(gl.MODELVIEW);
    gl.LoadIdentity();
    gl.MultMatrixf(view);

    for (const node of roots) this.drawObject(gl, node);
    return true;
  }

  drawObject(gl, node) {
    if (!node.visible) return;
    gl.PushMatrix();
    gl.MultMatrixf(node.localMatrix());
    if (node.kind === 'mesh') this.drawMesh(gl, node);
    for (const child of node.children) {
      if (child.isObject3D) this.drawObject(gl, child);
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

  /** Material state is per frame, so one geometry list can serve many meshes. */
  applyMaterial(gl, material) {
    const props = material?.props ?? {};
    const [r, g, b, a] = rgba(props.color);
    const opacity = props.opacity ?? 1;
    const alpha = a * opacity;
    const key = `${material?.kind}|${r},${g},${b},${alpha}|${props.wireframe}|${props.side}|${props.transparent}`;
    if (key === this.materialKey) return;
    this.materialKey = key;

    // <meshBasicMaterial> is unlit; the lit materials arrive with the lights
    gl.Disable(gl.LIGHTING);
    if (alpha < 1 || props.transparent) {
      gl.Enable(gl.BLEND);
      gl.BlendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.Color4f(r, g, b, alpha);
    } else {
      gl.Disable(gl.BLEND);
      gl.Color3f(r, g, b);
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

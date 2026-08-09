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
import { cssColorStraight } from 'ntk';

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
  // unlit by definition — a dot and a line have no surface to shade
  'pointsMaterial',
  'lineBasicMaterial',
  // GLSL, so only the direct backend can draw these — see DIRECT_ONLY_KINDS
  'shaderMaterial',
  'rawShaderMaterial',
]);

/**
 * Scene elements only the direct backend can render, with the reason the
 * indirect one cannot. The GLX protocol encodes no shader objects at all, so
 * this is a property of the transport rather than a gap someone could fill.
 */
export const DIRECT_ONLY_KINDS = {
  shaderMaterial: 'GLSL shaders: the GLX protocol encodes no shader objects',
  rawShaderMaterial: 'GLSL shaders: the GLX protocol encodes no shader objects',
};
export const LIGHT_KINDS = new Set([
  'ambientLight',
  'directionalLight',
  'pointLight',
  'spotLight',
]);
/** Drawables: a geometry and a material, assembled into some primitive. */
export const DRAWABLE_KINDS = new Set([
  'mesh',
  'instancedMesh',
  'points',
  'line',
  'lineSegments',
  'lineLoop',
]);
export const OBJECT_KINDS = new Set([
  ...DRAWABLE_KINDS,
  'group',
  ...LIGHT_KINDS,
]);
export const SCENE_KINDS = new Set([
  ...GEOMETRY_KINDS,
  ...MATERIAL_KINDS,
  ...OBJECT_KINDS,
]);

/** Materials with no surface to shade, which lighting never applies to. */
export const UNLIT_MATERIALS = new Set([
  'meshBasicMaterial',
  'pointsMaterial',
  'lineBasicMaterial',
]);

// Fixed-function GL has exactly eight light units. The shader backend has no
// such limit, but keeps the same cap so a scene lights identically on both.
export const MAX_LIGHTS = 8;

/**
 * react-three-fiber names no backend implements yet, with the reason. These
 * fail loudly instead of rendering something that only looks right.
 *
 * The list used to include the shader materials, and shrank when the direct
 * backend arrived: what is impossible over the GLX wire is merely unwritten
 * on the GPU. `DIRECT_ONLY_KINDS` is the middle ground — implemented, but
 * only where the pipeline can run it.
 */
export const UNSUPPORTED_KINDS = {
  effectComposer:
    'post-processing needs a render-target pipeline, which neither backend has yet',
};

const asTriple = (value, fallback) => {
  if (value == null) return fallback;
  if (typeof value === 'number') return [value, value, value];
  return [value[0] ?? 0, value[1] ?? 0, value[2] ?? 0];
};

/** Base for anything with a transform: `<mesh>`, `<group>`. */
export class Object3DNode extends Node {
  // `position`, `color`, `width`… are the scene graph's vocabulary here
  get stylable() {
    return false;
  }

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

/**
 * Anything that draws a geometry with a material: `<mesh>`, `<points>`,
 * `<line>` and friends. They differ only in the primitive their vertices are
 * assembled into, which both renderers read off `primitive` — the geometry,
 * the material and the transform work identically for all of them.
 */
export class MeshNode extends Object3DNode {
  constructor(props, app, kind = 'mesh') {
    super(kind, props, app);
  }

  get isDrawable() {
    return true;
  }

  /** 'triangles' | 'points' | 'lines' | 'lineStrip' | 'lineLoop' */
  get primitive() {
    return 'triangles';
  }

  get geometry() {
    return this.children.find((c) => c.isGeometry) ?? null;
  }

  get material() {
    return this.children.find((c) => c.isMaterial) ?? null;
  }
}

/** `<points>` — one vertex, one dot. Size comes from `<pointsMaterial>`. */
export class PointsNode extends MeshNode {
  constructor(props, app) {
    super(props, app, 'points');
  }

  get primitive() {
    return 'points';
  }
}

/**
 * `<line>`, `<lineSegments>`, `<lineLoop>` — the three ways three.js reads a
 * vertex list as lines: a connected strip, disjoint pairs, or a closed strip.
 */
export class LineNode extends MeshNode {
  constructor(kind, props, app) {
    super(props, app, kind);
  }

  get primitive() {
    if (this.kind === 'lineSegments') return 'lines';
    if (this.kind === 'lineLoop') return 'lineLoop';
    return 'lineStrip';
  }
}

/**
 * `<instancedMesh instances={[{ position, rotation, scale, color }, …]}>` —
 * one geometry drawn many times.
 *
 * The `instances` array is declarative rather than three.js's imperative
 * `setMatrixAt`, for the same reason the camera here is a prop: the tree is
 * the description, and a handle you have to mutate after the fact is not one.
 * Each entry takes the transform props `<mesh>` takes, plus an optional
 * `color` that overrides the material's.
 *
 * What it saves is the geometry, not the draw calls: the vertices are
 * uploaded (or compiled into a display list) once, and each instance costs a
 * transform and a draw. Neither backend does GPU instancing yet — ES 2 has
 * none guaranteed, and GLX encodes none at all.
 */
export class InstancedMeshNode extends MeshNode {
  constructor(props, app) {
    super(props, app, 'instancedMesh');
  }

  get instances() {
    const list = this.props.instances;
    return Array.isArray(list) ? list : [];
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

  /**
   * `{ positions, normals, uvs, index }` — memoized per prop version.
   *
   * `normals: false` is what a point cloud or a line asks for: nothing shades
   * them, and deriving face normals for a hundred thousand loose vertices is
   * a pass and a megabyte spent on data no shader will read.
   */
  data({ normals = true } = {}) {
    const key = normals ? 'shaded' : 'flat';
    if (!this._data) this._data = new Map();
    let built = this._data.get(key);
    if (!built) {
      const build = GEOMETRY_BUILDERS[this.kind];
      built = build
        ? build(this.props.args ?? [])
        : buildBufferGeometry(this.props, { normals });
      this._data.set(key, built);
    }
    return built;
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
  if (kind === 'instancedMesh') return new InstancedMeshNode(props, app);
  if (kind === 'points') return new PointsNode(props, app);
  if (kind === 'line' || kind === 'lineSegments' || kind === 'lineLoop') {
    return new LineNode(kind, props, app);
  }
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

// Material and light colours, straight alpha — these become GL state, and GL
// takes unassociated components. ntk's `cssColor` premultiplies for XRender,
// which would render a translucent material dark.
const rgba = (color, fallback = [1, 1, 1, 1]) => {
  if (!color) return fallback;
  if (Array.isArray(color)) return color.length === 4 ? color : [...color, 1];
  return cssColorStraight(color) ?? fallback;
};

/**
 * The colour reading both renderers share, so a material means the same
 * thing whichever pipeline draws it.
 */
export const materialColors = {
  /** a colour prop as [r, g, b], straight alpha dropped */
  rgb(color, fallback = [1, 1, 1]) {
    const [r, g, b] = rgba(color, [...fallback, 1]);
    return [r, g, b];
  },
  /** the four colour-ish values every standard material has */
  of(props) {
    const [r, g, b, a] = rgba(props.color);
    return {
      color: new Float32Array([r, g, b]),
      alpha: a * (props.opacity ?? 1),
      emissive: new Float32Array(this.rgb(props.emissive, [0, 0, 0])),
      specular: new Float32Array(
        this.rgb(
          props.specular === false ? undefined : props.specular,
          [1, 1, 1],
        ),
      ),
    };
  },
};

/** The GL primitive a drawable's vertices are assembled into. */
export function BEGIN_MODE(gl, primitive) {
  switch (primitive) {
    case 'points':
      return gl.POINTS;
    case 'lines':
      return gl.LINES;
    case 'lineStrip':
      return gl.LINE_STRIP;
    case 'lineLoop':
      return gl.LINE_LOOP;
    default:
      return gl.TRIANGLES;
  }
}

/** One `<instancedMesh>` entry's transform, in the parent's space. */
export function instanceMatrix(instance, out = new Float32Array(16)) {
  return compose(
    asTriple(instance.position, [0, 0, 0]),
    asTriple(instance.rotation, [0, 0, 0]),
    asTriple(instance.scale, [1, 1, 1]),
    out,
  );
}

/** Lights with their world matrices, in tree order. */
export function collectLights(nodes, parentMatrix, out = []) {
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
    this.backend = 'indirect';
    this.warnedDirectOnly = false;
    this.lists = new Map(); // GeometryNode -> { id, version }
    this.nextList = 1;
    this.textures = new Map(); // image -> texture id
    this.nextTexture = 1;
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
    if (node.isDrawable) this.drawMesh(gl, node);
    for (const child of node.children) {
      if (child.isObject3D) this.drawObject(gl, child, world);
    }
    gl.PopMatrix();
  }

  drawMesh(gl, mesh) {
    const geometry = mesh.geometry;
    if (!geometry) return;
    const applied = this.applyMaterial(gl, mesh.material);
    const list = this.listFor(gl, geometry, mesh.primitive);
    const instances = mesh.instances;
    if (!instances) return gl.CallList(list);

    // One list, replayed under each instance's transform. The geometry is
    // compiled once however many instances there are, which is the whole
    // saving; the per-instance cost is a matrix and a CallList.
    //
    // Colour is GL state, and PopMatrix restores the matrix and nothing else —
    // so once any instance has set one, every instance has to say what it
    // wants or it inherits its predecessor's.
    const colored = instances.some((instance) => instance.color);
    for (const instance of instances) {
      gl.PushMatrix();
      gl.MultMatrixf(instanceMatrix(instance));
      if (colored) {
        const [r, g, b] = instance.color
          ? rgba(instance.color)
          : (applied?.color ?? [1, 1, 1]);
        gl.Color3f(r, g, b);
      }
      gl.CallList(list);
      gl.PopMatrix();
    }
    // the material's own colour is no longer what is current
    if (colored) this.materialKey = null;
  }

  /**
   * Upload once, bind per frame. Texture pixels are the same problem as
   * geometry — kilobytes that must not cross the wire twice — so an ntk
   * `Image` is uploaded on first use and only rebound afterwards.
   * `map` is an ntk Image, or anything with { width, height, data } in
   * RGBA byte order.
   */
  textureFor(gl, image) {
    const cached = this.textures.get(image);
    if (cached) return cached;
    const id = this.nextTexture++;
    gl.BindTexture(gl.TEXTURE_2D, id);
    gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.TexImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      image.width,
      image.height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      image.data,
    );
    this.textures.set(image, id);
    return id;
  }

  /** Compile once, replay forever — this is the whole point of the design. */
  listFor(gl, geometry, primitive = 'triangles') {
    // Keyed by primitive as well as by geometry: the same vertices compiled
    // as triangles and as points are two different lists, and a scene can
    // legitimately use one geometry both ways.
    let perPrimitive = this.lists.get(geometry);
    if (!perPrimitive) this.lists.set(geometry, (perPrimitive = new Map()));
    const cached = perPrimitive.get(primitive);
    if (cached && cached.version === geometry.version) return cached.id;
    const id = cached ? cached.id : this.nextList++;

    const shaded = primitive === 'triangles';
    const { positions, normals, uvs, index } = geometry.data({
      normals: shaded,
    });
    // Points ignore any index — every vertex is one dot, and running the
    // triangle index over them would draw the shared ones repeatedly.
    const useIndex = primitive === 'points' ? null : index;
    const count = useIndex ? useIndex.length : positions.length / 3;

    gl.NewList(id, gl.COMPILE);
    gl.Begin(BEGIN_MODE(gl, primitive));
    for (let i = 0; i < count; i++) {
      const v = useIndex ? useIndex[i] : i;
      if (shaded && normals && normals.length > v * 3 + 2) {
        gl.Normal3f(normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2]);
      }
      if (shaded && uvs && uvs.length > v * 2 + 1) {
        gl.TexCoord2f(uvs[v * 2], uvs[v * 2 + 1]);
      }
      gl.Vertex3f(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
    }
    gl.End();
    gl.EndList();

    perPrimitive.set(primitive, { id, version: geometry.version });
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
    let kind = material?.kind ?? 'meshBasicMaterial';
    const props = material?.props ?? {};
    // A mesh that reached this renderer with a shader material can only
    // happen if the backend changed under a mounted tree; draw it flat rather
    // than as whatever an unknown kind falls through to.
    if (DIRECT_ONLY_KINDS[kind]) {
      if (!this.warnedDirectOnly) {
        this.warnedDirectOnly = true;
        console.warn(
          `react-x11: <${kind}> needs direct rendering — ${DIRECT_ONLY_KINDS[kind]}. ` +
            'Drawing it as an unlit material instead.',
        );
      }
      kind = 'meshBasicMaterial';
    }
    const [r, g, b, a] = rgba(props.color);
    const opacity = props.opacity ?? 1;
    const alpha = a * opacity;
    // <meshBasicMaterial> is unlit by definition — and so are the point and
    // line materials, which have no surface to shade. A lit material with no
    // light in the scene would render black, so that falls back to flat too.
    const lit = !UNLIT_MATERIALS.has(kind) && this.lit;
    // texturing is state like everything else here, so it is part of the key
    const map = props.map ?? null;
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
      props.size,
      props.linewidth,
      map ? (this.textures.get(map) ?? 'new') : 'none',
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

    if (map?.width && map?.data) {
      gl.Enable(gl.TEXTURE_2D);
      gl.BindTexture(gl.TEXTURE_2D, this.textureFor(gl, map));
      // MODULATE: the texture is tinted by the colour and the lighting
      gl.TexEnvi(gl.TEXTURE_ENV, gl.TEXTURE_ENV_MODE, gl.MODULATE);
    } else {
      gl.Disable(gl.TEXTURE_2D);
    }

    // three.js's names: `size` on a points material, `linewidth` on a line
    // one. Both are fixed-function state the GLX protocol does encode.
    if (kind === 'pointsMaterial') gl.PointSize(props.size ?? 1);
    if (kind === 'lineBasicMaterial') gl.LineWidth(props.linewidth ?? 1);

    gl.PolygonMode(gl.FRONT_AND_BACK, props.wireframe ? gl.LINE : gl.FILL);
    if (props.side === 'double') {
      gl.Disable(gl.CULL_FACE);
    } else {
      gl.Enable(gl.CULL_FACE);
      gl.CullFace(props.side === 'back' ? gl.FRONT : gl.BACK);
    }
    // handed back so <instancedMesh> can put it back between instances that
    // override the colour and instances that do not
    return { color: [r, g, b] };
  }

  /** Drop a removed geometry's lists so the ids can be reused. */
  forget(gl, node) {
    const perPrimitive = this.lists.get(node);
    if (!perPrimitive) return;
    this.lists.delete(node);
    for (const { id } of perPrimitive.values()) gl?.DeleteLists?.(id, 1);
  }

  dispose(gl) {
    for (const perPrimitive of this.lists.values()) {
      for (const { id } of perPrimitive.values()) gl?.DeleteLists?.(id, 1);
    }
    this.lists.clear();
    if (this.textures.size) gl?.DeleteTextures?.([...this.textures.values()]);
    this.textures.clear();
  }
}

// The same scene tree, drawn through OpenGL ES 2 on the GPU.
//
// `src/scene3d.js` renders `<mesh>`/`<group>`/materials/lights through
// indirect GLX, where the pipeline is fixed-function and geometry can only
// reach the server as immediate-mode commands compiled into display lists.
// This renders the identical tree through ntk's direct backend, where none of
// that applies: geometry is a vertex buffer on the GPU, materials are
// generated GLSL, and a frame is a handful of uniform writes and one draw
// call per mesh.
//
// The node classes, the camera, the light collection and the colour handling
// are shared — only the drawing differs, which is the whole point of keeping
// the split at the renderer rather than at the elements.
//
// Two deliberate differences from the fixed-function path, both improvements
// the hardware makes free:
//
//  - **lighting is per fragment.** Fixed-function GL shades per vertex, so a
//    large triangle lit by a nearby point light bands visibly. Shading in the
//    fragment shader is what three.js does with the same material names, and
//    what anyone reaching for this backend expects.
//  - **the shader is generated for the scene it draws.** A program is
//    compiled per (material kind, lit, textured, light count) so a scene with
//    two lights spends two lights' worth of uniforms — ES 2 guarantees very
//    few of those, and a fixed eight-light shader would not fit the minimum.

import {
  MAX_LIGHTS,
  UNLIT_MATERIALS,
  cameraMatrices,
  collectLights,
  instanceMatrix,
  materialColors,
} from './scene3d.js';
import { identity, invert, multiply } from './mat4.js';

/**
 * The default float precision, injected into **both** stages.
 *
 * GLSL ES requires a uniform declared in the vertex and the fragment shader
 * to carry the same precision, and the default differs between them: `highp`
 * in a vertex shader, nothing at all in a fragment shader. So a `uniform
 * float uTime` used in both — the most ordinary thing a shader does — fails
 * to *link*, with "mismatching precision qualifiers", unless something says
 * otherwise. three.js injects a default for the same reason.
 *
 * `mediump` rather than `highp` because it is what a fragment shader copied
 * from anywhere declares at the top, and a user redeclaring the same value is
 * then still consistent with the vertex stage.
 */
const PRECISION = 'precision mediump float;\n';

// three.js's attribute and matrix names, so a shader written against r3f — or
// copied out of a tutorial — compiles here unchanged
const COMMON_VERTEX_UNIFORMS = `${PRECISION}
uniform mat4 projectionMatrix;
uniform mat4 modelViewMatrix;
uniform mat4 modelMatrix;
uniform mat3 normalMatrix;
attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;
`;

/**
 * The vertex/fragment pair for one material configuration.
 *
 * `lights` is the exact number of light slots to declare. Zero means the
 * shader has no lighting code at all rather than a loop that runs no
 * iterations, which keeps an unlit scene's program genuinely small.
 */
function materialProgramSource({ kind, lit, textured, lights, primitive }) {
  const phong = kind === 'meshPhongMaterial';
  const points = primitive === 'points';
  const vertex = `${COMMON_VERTEX_UNIFORMS}${points ? 'uniform float pointSize;\n' : ''}
varying vec3 vNormal;
varying vec3 vViewPosition;
varying vec2 vUv;
void main() {
  vUv = uv;
  vNormal = normalize(normalMatrix * normal);
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  // the direction from the surface toward the eye, which is the origin in
  // view space
  vViewPosition = -mvPosition.xyz;
  gl_Position = projectionMatrix * mvPosition;
${points ? '  // ES 2 has no glPointSize: a point sprite is sized by the vertex shader\n  gl_PointSize = pointSize;\n' : ''}}`;

  const lighting = lit
    ? `
uniform vec3 ambientColor;
// w picks the kind: 0 is a direction toward the light, 1 is a position
uniform vec4 lightPosition[${lights}];
uniform vec3 lightColor[${lights}];
uniform vec3 spotDirection[${lights}];
// x = cos(cutoff) or -1 for a light that is not a spot, y = spot exponent,
// z = linear attenuation, w unused
uniform vec4 spotParams[${lights}];
`
    : '';

  const lightingBody = lit
    ? `
  vec3 normal = normalize(vNormal) * (gl_FrontFacing ? 1.0 : -1.0);
  vec3 viewDir = normalize(vViewPosition);
  vec3 lit = ambientColor * diffuseColor;
  for (int i = 0; i < ${lights}; i++) {
    vec3 toLight;
    float attenuation = 1.0;
    if (lightPosition[i].w == 0.0) {
      toLight = normalize(lightPosition[i].xyz);
    } else {
      vec3 offset = lightPosition[i].xyz - (-vViewPosition);
      float dist = length(offset);
      toLight = offset / max(dist, 0.0001);
      attenuation = 1.0 / (1.0 + spotParams[i].z * dist);
      if (spotParams[i].x >= -0.5) {
        float aligned = dot(-toLight, normalize(spotDirection[i]));
        attenuation *= aligned < spotParams[i].x
          ? 0.0
          : pow(aligned, spotParams[i].y);
      }
    }
    float diffuse = max(dot(normal, toLight), 0.0);
    lit += diffuseColor * lightColor[i] * diffuse * attenuation;
${
  phong
    ? `    if (diffuse > 0.0) {
      vec3 halfway = normalize(toLight + viewDir);
      float spec = pow(max(dot(normal, halfway), 0.0), max(shininess, 0.0001));
      lit += specularColor * lightColor[i] * spec * attenuation;
    }`
    : ''
}
  }
  vec3 color = lit + emissiveColor;`
    : `
  vec3 color = diffuseColor;`;

  const fragment = `${PRECISION}uniform vec3 diffuse;
uniform float opacity;
uniform vec3 emissive;
${phong ? 'uniform vec3 specular;\nuniform float shininess;\n' : ''}${textured ? 'uniform sampler2D map;\n' : ''}${lighting}
varying vec3 vNormal;
varying vec3 vViewPosition;
varying vec2 vUv;
void main() {
  vec4 base = vec4(diffuse, opacity);
${textured ? '  base *= texture2D(map, vUv);\n' : ''}
  vec3 diffuseColor = base.rgb;
  vec3 emissiveColor = ${lit ? 'emissive' : 'vec3(0.0)'};
${phong ? '  vec3 specularColor = specular;\n' : ''}${lightingBody}
  gl_FragColor = vec4(color, base.a);
}`;

  return { vertex, fragment };
}

/** Shader sources for a `<shaderMaterial>`, with three.js's prelude. */
function userProgramSource(props, raw) {
  const vertex = raw
    ? props.vertexShader
    : `${COMMON_VERTEX_UNIFORMS}uniform vec3 cameraPosition;
${props.vertexShader ?? ''}`;
  const fragment = raw
    ? props.fragmentShader
    : `${PRECISION}${props.fragmentShader ?? ''}`;
  return { vertex, fragment };
}

/** The ES 2 draw mode a drawable's primitive assembles into. */
function PRIMITIVE_MODE(gl, primitive) {
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

const isTypedArray = (v) => ArrayBuffer.isView(v) && !(v instanceof DataView);

/**
 * A `<shaderMaterial>` uniform value, in three.js's `{ value }` shape, sent
 * with whichever setter its JavaScript type implies. Matrices need a typed
 * array, since nothing else says "this is a mat3, not three vec3s".
 */
function setUniform(gl, location, value) {
  if (location === null || location === -1 || value === undefined) return;
  if (typeof value === 'number') return gl.uniform1f(location, value);
  if (typeof value === 'boolean') return gl.uniform1i(location, value ? 1 : 0);
  if (value && value.__texture !== undefined) {
    return gl.uniform1i(location, value.__texture);
  }
  if (isTypedArray(value) || Array.isArray(value)) {
    const array =
      value instanceof Float32Array ? value : new Float32Array(value);
    switch (array.length) {
      case 2:
        return gl.uniform2fv(location, array);
      case 3:
        return gl.uniform3fv(location, array);
      case 4:
        return gl.uniform4fv(location, array);
      case 9:
        return gl.uniformMatrix3fv(location, false, array);
      case 16:
        return gl.uniformMatrix4fv(location, false, array);
      default:
        return gl.uniform1fv(location, array);
    }
  }
}

/** The 3x3 inverse-transpose that takes a normal into view space. */
function normalMatrix(modelView, out = new Float32Array(9)) {
  const inverse = invert(modelView);
  if (!inverse) {
    // a degenerate transform (a zero scale): leave normals alone rather than
    // filling the buffer with NaN, which would blacken the whole mesh
    out.set([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    return out;
  }
  // transpose of the inverse, upper 3x3, from a column-major 4x4
  out[0] = inverse[0];
  out[1] = inverse[4];
  out[2] = inverse[8];
  out[3] = inverse[1];
  out[4] = inverse[5];
  out[5] = inverse[9];
  out[6] = inverse[2];
  out[7] = inverse[6];
  out[8] = inverse[10];
  return out;
}

/**
 * Per-surface GPU state for the direct backend: one buffer set per geometry,
 * one program per material configuration, one texture per image.
 *
 * The interface is `SceneRenderer`'s — `render`, `forget`, `dispose` — so
 * `<glarea>` holds one or the other and never asks which.
 */
export class ShaderSceneRenderer {
  constructor(surface) {
    this.surface = surface;
    this.backend = 'direct';
    this.geometries = new Map(); // GeometryNode -> { version, buffers... }
    this.programs = new Map(); // signature -> { program, uniforms, attributes }
    this.textures = new Map(); // image -> { texture, unit }
    this.camera = null;
    this.failed = new Set(); // shader sources already reported as broken
  }

  render(gl, info) {
    const roots = this.surface.children.filter((c) => c.isObject3D);
    if (roots.length === 0) return false;
    if (!this.usable(gl)) return false;

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);

    const { projection, view } = cameraMatrices(
      this.surface.props.camera,
      info,
    );
    this.camera = { projection, view, width: info.width, height: info.height };

    const lights = collectLights(roots, identity());
    const uniforms = this.lightUniforms(lights, view);

    for (const node of roots) this.drawObject(gl, node, identity(), uniforms);
    return true;
  }

  /**
   * Does this context have the GL entry points a material needs?
   *
   * It can genuinely lack them. ntk passes the addon's table straight through,
   * so the context is only as complete as the `x11-dri` that was installed —
   * and npm will happily nest an old copy under `node_modules/ntk` where its
   * declared range asks for one. The failure without this check is a
   * `TypeError: gl.uniform3fv is not a function` thrown from inside a draw
   * call, which names nothing a consumer could act on.
   */
  usable(gl) {
    if (this._usable !== undefined) return this._usable;
    const missing = [
      'createBuffer',
      'bufferData',
      'createShader',
      'linkProgram',
      'uniform3fv',
      'uniformMatrix4fv',
      'uniformMatrix3fv',
      'drawElements',
      'blendFunc',
      'depthMask',
    ].filter((name) => typeof gl[name] !== 'function');
    this._usable = missing.length === 0;
    if (!this._usable) {
      const err = new Error(
        `react-x11: this GL context is missing ${missing.join(', ')}, so the 3D ` +
          'scene cannot be drawn.\n' +
          'The direct backend exposes whatever the x11-dri addon provides, and ' +
          'this one is too old — it needs >= 0.3.0. npm may have nested an older ' +
          "copy under node_modules/ntk to satisfy ntk's declared range; check " +
          'with `npm ls x11-dri`.',
      );
      err.code = 'GL_CONTEXT_INCOMPLETE';
      this.report('gl-incomplete', err.message);
    }
    return this._usable;
  }

  /**
   * Lights as flat arrays in view space, which is where the shader works.
   *
   * Positions are transformed here rather than in the shader for the same
   * reason fixed-function GL transforms them when they are set: the light is
   * in the world, and the surface being lit is not, so one of the two has to
   * move and doing it once per frame beats once per fragment.
   */
  lightUniforms(lights, view) {
    const ambient = [0, 0, 0];
    const used = [];
    for (const light of lights) {
      const { node } = light;
      const intensity = node.props.intensity ?? 1;
      const [r, g, b] = materialColors.rgb(node.props.color);
      if (node.kind === 'ambientLight') {
        ambient[0] += r * intensity;
        ambient[1] += g * intensity;
        ambient[2] += b * intensity;
        continue;
      }
      if (used.length >= MAX_LIGHTS) continue;
      used.push({ node, intensity, color: [r, g, b], world: light.world });
    }

    const count = used.length;
    const position = new Float32Array(Math.max(1, count) * 4);
    const color = new Float32Array(Math.max(1, count) * 3);
    const spotDirection = new Float32Array(Math.max(1, count) * 3);
    const spotParams = new Float32Array(Math.max(1, count) * 4);

    used.forEach((light, i) => {
      const { node, intensity, world } = light;
      const wx = world[12];
      const wy = world[13];
      const wz = world[14];
      const directional = node.kind === 'directionalLight';
      // view-space position (w = 1) or direction toward the light (w = 0)
      const w = directional ? 0 : 1;
      position[i * 4] =
        view[0] * wx + view[4] * wy + view[8] * wz + view[12] * w;
      position[i * 4 + 1] =
        view[1] * wx + view[5] * wy + view[9] * wz + view[13] * w;
      position[i * 4 + 2] =
        view[2] * wx + view[6] * wy + view[10] * wz + view[14] * w;
      position[i * 4 + 3] = w;
      color[i * 3] = light.color[0] * intensity;
      color[i * 3 + 1] = light.color[1] * intensity;
      color[i * 3 + 2] = light.color[2] * intensity;

      const distance = node.props.distance ?? 0;
      spotParams[i * 4 + 2] = distance > 0 ? 1 / distance : 0;
      if (node.kind === 'spotLight') {
        const target = node.props.target ?? [0, 0, 0];
        const dx = target[0] - wx;
        const dy = target[1] - wy;
        const dz = target[2] - wz;
        const length = Math.hypot(dx, dy, dz) || 1;
        // the direction is a vector, so the translation column does not apply
        spotDirection[i * 3] =
          (view[0] * dx + view[4] * dy + view[8] * dz) / length;
        spotDirection[i * 3 + 1] =
          (view[1] * dx + view[5] * dy + view[9] * dz) / length;
        spotDirection[i * 3 + 2] =
          (view[2] * dx + view[6] * dy + view[10] * dz) / length;
        const angle = node.props.angle ?? Math.PI / 6;
        spotParams[i * 4] = Math.cos(Math.min(Math.PI / 2, angle));
        spotParams[i * 4 + 1] = (node.props.penumbra ?? 0) * 128;
      } else {
        spotParams[i * 4] = -1; // not a spot
        spotParams[i * 4 + 1] = 0;
      }
    });

    return {
      count,
      ambient: new Float32Array(ambient),
      position,
      color,
      spotDirection,
      spotParams,
      lit: count > 0 || ambient.some((c) => c > 0),
    };
  }

  drawObject(gl, node, parentWorld, lights) {
    if (!node.visible) return;
    const world = multiply(parentWorld, node.localMatrix());
    node._world = world;
    if (node.isDrawable) this.drawMesh(gl, node, world, lights);
    for (const child of node.children) {
      if (child.isObject3D) this.drawObject(gl, child, world, lights);
    }
  }

  drawMesh(gl, mesh, world, lights) {
    const geometry = mesh.geometry;
    if (!geometry) return;
    const primitive = mesh.primitive;
    const buffers = this.geometryFor(gl, geometry, primitive);
    if (!buffers) return;

    const material = mesh.material;
    const program = this.programFor(gl, material, lights, primitive);
    if (!program) return;

    gl.useProgram(program.program);
    const applied = this.applyMaterial(gl, program, material, lights);

    gl.uniformMatrix4fv(
      program.uniform('projectionMatrix'),
      false,
      this.camera.projection,
    );
    gl.uniformMatrix4fv(program.uniform('viewMatrix'), false, this.camera.view);
    this.bindAttributes(gl, program, buffers);

    const instances = mesh.instances;
    if (!instances) return this.drawOne(gl, program, buffers, world, primitive);

    // One upload, many transforms. Neither backend does GPU instancing — ES 2
    // guarantees none and GLX encodes none — so what this saves is the
    // geometry, not the draw calls: each instance is a matrix and a draw.
    const diffuse = program.uniform('diffuse');
    for (const instance of instances) {
      if (instance.color) {
        gl.uniform3fv(
          diffuse,
          new Float32Array(materialColors.rgb(instance.color)),
        );
      } else if (applied?.color) {
        gl.uniform3fv(diffuse, applied.color);
      }
      this.drawOne(
        gl,
        program,
        buffers,
        multiply(world, instanceMatrix(instance)),
        primitive,
      );
    }
  }

  /** One draw of `buffers` at `world`, as whichever primitive. */
  drawOne(gl, program, buffers, world, primitive) {
    const modelView = multiply(this.camera.view, world);
    gl.uniformMatrix4fv(program.uniform('modelViewMatrix'), false, modelView);
    gl.uniformMatrix4fv(program.uniform('modelMatrix'), false, world);
    gl.uniformMatrix3fv(
      program.uniform('normalMatrix'),
      false,
      normalMatrix(modelView),
    );
    const mode = PRIMITIVE_MODE(gl, primitive);
    if (buffers.index) {
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffers.index);
      gl.drawElements(mode, buffers.count, gl.UNSIGNED_SHORT, 0);
    } else {
      gl.drawArrays(mode, 0, buffers.count);
    }
  }

  bindAttributes(gl, program, buffers) {
    for (const [name, buffer, size] of [
      ['position', buffers.position, 3],
      ['normal', buffers.normal, 3],
      ['uv', buffers.uv, 2],
    ]) {
      const location = program.attribute(name);
      if (location < 0) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
    }
  }

  /**
   * Upload a geometry once and keep it on the GPU.
   *
   * The indirect backend compiles geometry into a display list for exactly
   * the same reason — never send the vertices twice — and the cache is keyed
   * the same way, by node identity and prop version.
   */
  geometryFor(gl, node, primitive = 'triangles') {
    // Keyed by primitive as well as by node: points and lines want no
    // normals and ignore the triangle index, so the same geometry used both
    // ways is genuinely two uploads.
    const shaded = primitive === 'triangles';
    const key = shaded ? 'shaded' : 'flat';
    let perPrimitive = this.geometries.get(node);
    if (!perPrimitive) this.geometries.set(node, (perPrimitive = new Map()));
    const cached = perPrimitive.get(key);
    if (cached && cached.version === node.version) return cached;
    if (cached) this.releaseGeometry(gl, cached);

    const built = node.data({ normals: shaded });
    const { positions, normals, uvs } = built;
    // points are one dot per vertex; running a triangle index over them
    // would draw every shared vertex again
    const index = primitive === 'points' ? null : built.index;
    const vertexCount = positions.length / 3;
    if (vertexCount === 0) return null;

    const upload = (data, fallbackLength) => {
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      const array =
        data && data.length
          ? data instanceof Float32Array
            ? data
            : new Float32Array(data)
          : new Float32Array(fallbackLength);
      gl.bufferData(gl.ARRAY_BUFFER, array, gl.STATIC_DRAW);
      return buffer;
    };

    const entry = {
      version: node.version,
      position: upload(positions, vertexCount * 3),
      normal: upload(normals, vertexCount * 3),
      uv: upload(uvs, vertexCount * 2),
      index: null,
      count: vertexCount,
    };

    if (index && index.length) {
      // ES 2 indices are 16-bit. A geometry with more vertices than that is
      // expanded to a flat triangle soup rather than quietly wrapping —
      // sphereGeometry with enough segments really does get there.
      if (vertexCount > 0xffff) {
        const flat = { positions: [], normals: [], uvs: [] };
        for (const i of index) {
          flat.positions.push(
            positions[i * 3],
            positions[i * 3 + 1],
            positions[i * 3 + 2],
          );
          flat.normals.push(
            normals[i * 3],
            normals[i * 3 + 1],
            normals[i * 3 + 2],
          );
          flat.uvs.push(uvs[i * 2], uvs[i * 2 + 1]);
        }
        this.releaseGeometry(gl, entry);
        entry.position = upload(flat.positions, 0);
        entry.normal = upload(flat.normals, 0);
        entry.uv = upload(flat.uvs, 0);
        entry.index = null;
        entry.count = index.length;
      } else {
        entry.index = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, entry.index);
        gl.bufferData(
          gl.ELEMENT_ARRAY_BUFFER,
          new Uint16Array(index),
          gl.STATIC_DRAW,
        );
        entry.count = index.length;
      }
    }

    perPrimitive.set(key, entry);
    return entry;
  }

  releaseGeometry(gl, entry) {
    for (const key of ['position', 'normal', 'uv', 'index']) {
      if (entry[key]) gl.deleteBuffer(entry[key]);
      entry[key] = null;
    }
  }

  /** Compile once per material configuration, reuse for every mesh using it. */
  programFor(gl, material, lights, primitive = 'triangles') {
    const kind = material?.kind ?? 'meshBasicMaterial';
    const props = material?.props ?? {};
    const user = kind === 'shaderMaterial' || kind === 'rawShaderMaterial';

    let signature;
    let source;
    if (user) {
      signature = `${kind} ${props.vertexShader ?? ''} ${props.fragmentShader ?? ''}`;
      source = userProgramSource(props, kind === 'rawShaderMaterial');
    } else {
      const lit = !UNLIT_MATERIALS.has(kind) && lights.lit && lights.count > 0;
      const textured = !!(props.map?.width && props.map?.data);
      // the primitive is part of the signature because only a points program
      // declares (and writes) gl_PointSize
      signature = `${kind}|${lit}|${textured}|${lights.count}|${primitive}`;
      source = materialProgramSource({
        kind,
        lit,
        textured,
        lights: lights.count,
        primitive,
      });
    }

    const cached = this.programs.get(signature);
    if (cached) return cached.program ? cached : null;

    const entry = this.compile(gl, source, signature, kind);
    this.programs.set(signature, entry);
    return entry.program ? entry : null;
  }

  compile(gl, source, signature, kind) {
    const shader = (type, text, what) => {
      const object = gl.createShader(type);
      gl.shaderSource(object, text);
      gl.compileShader(object);
      if (gl.getShaderParameter(object, gl.COMPILE_STATUS)) return object;
      this.report(
        signature,
        `${kind}: ${what} failed to compile\n${gl.getShaderInfoLog(object)}`,
      );
      gl.deleteShader(object);
      return null;
    };

    const vertex = shader(gl.VERTEX_SHADER, source.vertex, 'vertex shader');
    const fragment =
      vertex && shader(gl.FRAGMENT_SHADER, source.fragment, 'fragment shader');
    if (!vertex || !fragment) {
      if (vertex) gl.deleteShader(vertex);
      return { program: null };
    }

    const program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      this.report(
        signature,
        `${kind}: program failed to link\n${gl.getProgramInfoLog(program)}`,
      );
      gl.deleteProgram(program);
      return { program: null };
    }

    const uniforms = new Map();
    const attributes = new Map();
    return {
      program,
      uniform(name) {
        if (!uniforms.has(name))
          uniforms.set(name, gl.getUniformLocation(program, name));
        return uniforms.get(name);
      },
      attribute(name) {
        if (!attributes.has(name))
          attributes.set(name, gl.getAttribLocation(program, name));
        return attributes.get(name);
      },
    };
  }

  /**
   * A shader that will not build is reported once and then skipped. Throwing
   * would take down a render that is otherwise fine, and repeating it every
   * frame would bury the message it came with — which is the compiler's own
   * log, and the only thing that says what to fix.
   */
  report(signature, message) {
    if (this.failed.has(signature)) return;
    this.failed.add(signature);
    const onError = this.surface.props.onError;
    const err = new Error(`react-x11: ${message}`);
    err.code = 'GL_SHADER_FAILED';
    if (onError) onError(err);
    else console.warn(err.message);
  }

  applyMaterial(gl, program, material, lights) {
    const kind = material?.kind ?? 'meshBasicMaterial';
    const props = material?.props ?? {};

    if (kind === 'shaderMaterial' || kind === 'rawShaderMaterial') {
      gl.uniform3fv(program.uniform('cameraPosition'), this.cameraPosition());
      const uniforms = props.uniforms ?? {};
      for (const name of Object.keys(uniforms)) {
        const entry = uniforms[name];
        const value =
          entry && typeof entry === 'object' && 'value' in entry
            ? entry.value
            : entry;
        if (value?.width && value?.data) {
          const unit = this.textureFor(gl, value);
          gl.uniform1i(program.uniform(name), unit);
        } else {
          setUniform(gl, program.uniform(name), value);
        }
      }
      this.applyDrawState(
        gl,
        props,
        props.transparent || (props.opacity ?? 1) < 1,
      );
      return;
    }

    const { color, alpha, emissive, specular } = materialColors.of(props);
    gl.uniform3fv(program.uniform('diffuse'), color);
    // three.js's names: `size` on a points material, `linewidth` on a line one
    if (kind === 'pointsMaterial') {
      gl.uniform1f(program.uniform('pointSize'), props.size ?? 1);
    }
    if (kind === 'lineBasicMaterial') gl.lineWidth(props.linewidth ?? 1);
    gl.uniform1f(program.uniform('opacity'), alpha);
    gl.uniform3fv(program.uniform('emissive'), emissive);
    if (kind === 'meshPhongMaterial') {
      gl.uniform3fv(program.uniform('specular'), specular);
      gl.uniform1f(program.uniform('shininess'), props.shininess ?? 30);
    }

    const map = props.map;
    if (map?.width && map?.data) {
      gl.uniform1i(program.uniform('map'), this.textureFor(gl, map));
    }

    if (lights.count > 0 || lights.lit) {
      gl.uniform3fv(program.uniform('ambientColor'), lights.ambient);
      if (lights.count > 0) {
        gl.uniform4fv(program.uniform('lightPosition[0]'), lights.position);
        gl.uniform3fv(program.uniform('lightColor[0]'), lights.color);
        gl.uniform3fv(
          program.uniform('spotDirection[0]'),
          lights.spotDirection,
        );
        gl.uniform4fv(program.uniform('spotParams[0]'), lights.spotParams);
      }
    }

    this.applyDrawState(gl, props, alpha < 1 || props.transparent);
    // handed back so <instancedMesh> can restore it between instances that
    // override the colour and instances that do not
    return { color };
  }

  /** Blending, culling and depth writes — the state a material implies. */
  applyDrawState(gl, props, blended) {
    if (blended) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      // a translucent surface must not hide what is behind it
      gl.depthMask(false);
    } else {
      gl.disable(gl.BLEND);
      gl.depthMask(true);
    }
    if (props.side === 'double') {
      gl.disable(gl.CULL_FACE);
    } else {
      gl.enable(gl.CULL_FACE);
      gl.cullFace(props.side === 'back' ? gl.FRONT : gl.BACK);
    }
  }

  cameraPosition() {
    // the eye is the origin in view space, so its world position is the
    // translation of the inverted view matrix
    const inverse = invert(this.camera.view);
    return inverse
      ? new Float32Array([inverse[12], inverse[13], inverse[14]])
      : new Float32Array(3);
  }

  /**
   * Upload an image once and bind it to a texture unit. `map` is an ntk
   * `Image`, or anything with `{ width, height, data }` in RGBA byte order —
   * the same contract the indirect renderer takes.
   */
  textureFor(gl, image) {
    const cached = this.textures.get(image);
    if (cached) {
      gl.activeTexture(gl.TEXTURE0 + cached.unit);
      gl.bindTexture(gl.TEXTURE_2D, cached.texture);
      return cached.unit;
    }
    const unit = this.textures.size;
    const texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const data =
      image.data instanceof Uint8Array
        ? image.data
        : new Uint8Array(image.data);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      image.width,
      image.height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      data,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    // REPEAT needs power-of-two dimensions in ES 2; CLAMP_TO_EDGE always works
    const pot = (n) => (n & (n - 1)) === 0;
    const wrap =
      pot(image.width) && pot(image.height) ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    this.textures.set(image, { texture, unit });
    return unit;
  }

  /** A removed geometry's buffers are no longer needed on the GPU. */
  forget(gl, node) {
    const perPrimitive = this.geometries.get(node);
    if (!perPrimitive) return;
    this.geometries.delete(node);
    if (gl)
      for (const entry of perPrimitive.values())
        this.releaseGeometry(gl, entry);
  }

  dispose(gl) {
    if (gl) {
      for (const perPrimitive of this.geometries.values()) {
        for (const entry of perPrimitive.values()) {
          this.releaseGeometry(gl, entry);
        }
      }
      for (const { program } of this.programs.values()) {
        if (program) gl.deleteProgram(program);
      }
      for (const { texture } of this.textures.values())
        gl.deleteTexture(texture);
    }
    this.geometries.clear();
    this.programs.clear();
    this.textures.clear();
  }
}

export default ShaderSceneRenderer;

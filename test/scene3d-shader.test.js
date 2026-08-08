// The direct backend's scene renderer, asserted on the **GL call stream** it
// produces against a recording fake — the same idea as scene3d.test.js, which
// checks the encoded GLX bytes for the indirect one. What matters is a
// protocol property either way: geometry reaches the GPU once and a frame is
// uniforms plus a draw call, never the vertices again.
//
// Hermetic by construction: no X server, no GPU, no addon. The renderer only
// ever touches `gl`, so a fake one is the whole environment.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ShaderSceneRenderer } from '../src/scene3d-shader.js';
import { createSceneNode } from '../src/scene3d.js';

/** A `gl` that records every call and answers queries optimistically. */
function fakeGL({ compileFails = false, linkFails = false } = {}) {
  const calls = [];
  let nextId = 1;
  const record =
    (name, result) =>
    (...args) => {
      calls.push({ name, args });
      return typeof result === 'function' ? result(...args) : result;
    };
  const gl = {
    calls,
    shaderSources: [],
    // the constants the renderer reads; the values only have to be distinct
    TRIANGLES: 4,
    UNSIGNED_SHORT: 0x1403,
    FLOAT: 0x1406,
    ARRAY_BUFFER: 0x8892,
    ELEMENT_ARRAY_BUFFER: 0x8893,
    STATIC_DRAW: 0x88e4,
    DEPTH_TEST: 0x0b71,
    CULL_FACE: 0x0b44,
    BLEND: 0x0be2,
    LEQUAL: 0x0203,
    FRONT: 0x0404,
    BACK: 0x0405,
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    TEXTURE_2D: 0x0de1,
    TEXTURE0: 0x84c0,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    LINEAR: 0x2601,
    REPEAT: 0x2901,
    CLAMP_TO_EDGE: 0x812f,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    UNPACK_ALIGNMENT: 0x0cf5,
  };
  for (const name of [
    'enable',
    'disable',
    'depthFunc',
    'depthMask',
    'cullFace',
    'blendFunc',
    'useProgram',
    'bindBuffer',
    'bufferData',
    'deleteBuffer',
    'enableVertexAttribArray',
    'vertexAttribPointer',
    'drawArrays',
    'drawElements',
    'uniform1f',
    'uniform1i',
    'uniform2fv',
    'uniform3fv',
    'uniform4fv',
    'uniform1fv',
    'uniformMatrix3fv',
    'uniformMatrix4fv',
    'attachShader',
    'linkProgram',
    'deleteShader',
    'deleteProgram',
    'deleteTexture',
    'bindTexture',
    'activeTexture',
    'texImage2D',
    'texParameteri',
    'pixelStorei',
  ]) {
    gl[name] = record(name);
  }
  gl.createBuffer = record('createBuffer', () => ({ id: nextId++ }));
  gl.createTexture = record('createTexture', () => ({ id: nextId++ }));
  gl.createProgram = record('createProgram', () => ({ id: nextId++ }));
  gl.createShader = record('createShader', (type) => ({ id: nextId++, type }));
  gl.shaderSource = (shader, source) => {
    calls.push({ name: 'shaderSource', args: [shader, source] });
    gl.shaderSources.push({ type: shader.type, source });
  };
  gl.compileShader = record('compileShader');
  gl.getShaderParameter = () => !compileFails;
  gl.getProgramParameter = () => !linkFails;
  gl.getShaderInfoLog = () => 'ERROR: 0:3 syntax error';
  gl.getProgramInfoLog = () => 'link failed';
  gl.getUniformLocation = (program, name) => `u:${name}`;
  gl.getAttribLocation = (program, name) =>
    ({ position: 0, normal: 1, uv: 2 })[name] ?? -1;
  return gl;
}

const named = (gl, name) => gl.calls.filter((c) => c.name === name);
const countOf = (gl, name) => named(gl, name).length;

/** A `<glarea>` as far as the renderer is concerned. */
function surfaceWith(children, props = {}) {
  return { children, props };
}

function mesh(geometry, material, props = {}) {
  const node = createSceneNode('mesh', props, null);
  if (geometry) node.insertBefore(geometry, null);
  if (material) node.insertBefore(material, null);
  return node;
}

const box = (props = { args: [1, 1, 1] }) =>
  createSceneNode('boxGeometry', props, null);
const material = (kind, props = {}) => createSceneNode(kind, props, null);
const light = (kind, props = {}) => createSceneNode(kind, props, null);

const info = { width: 200, height: 100 };

describe('geometry reaches the GPU once', () => {
  test('a second frame uploads nothing and still draws', () => {
    const gl = fakeGL();
    const geometry = box();
    const renderer = new ShaderSceneRenderer(
      surfaceWith([mesh(geometry, material('meshBasicMaterial'))]),
    );

    renderer.render(gl, info);
    const uploads = countOf(gl, 'bufferData');
    assert.ok(uploads >= 3, `positions, normals and uvs at least: ${uploads}`);
    assert.equal(countOf(gl, 'drawElements'), 1);

    gl.calls.length = 0;
    renderer.render(gl, info);
    assert.equal(
      countOf(gl, 'bufferData'),
      0,
      'a steady-state frame re-uploads no geometry',
    );
    assert.equal(countOf(gl, 'drawElements'), 1, 'and still draws');
  });

  test('a transform change is uniforms only', () => {
    const gl = fakeGL();
    const node = mesh(box(), material('meshBasicMaterial'));
    const renderer = new ShaderSceneRenderer(surfaceWith([node]));
    renderer.render(gl, info);

    gl.calls.length = 0;
    node.applyProps({ position: [3, 0, 0] });
    renderer.render(gl, info);
    assert.equal(countOf(gl, 'bufferData'), 0);
    // the model-view matrix moved, which is the whole cost of the change
    const matrices = named(gl, 'uniformMatrix4fv').map((c) => c.args[0]);
    assert.ok(matrices.includes('u:modelViewMatrix'));
  });

  test('a geometry prop change re-uploads exactly once', () => {
    const gl = fakeGL();
    const geometry = box();
    const renderer = new ShaderSceneRenderer(
      surfaceWith([mesh(geometry, material('meshBasicMaterial'))]),
    );
    renderer.render(gl, info);

    gl.calls.length = 0;
    geometry.applyProps({ args: [2, 2, 2] });
    renderer.render(gl, info);
    assert.ok(countOf(gl, 'bufferData') >= 3, 'the new shape is uploaded');
    // and the buffers the old shape held are handed back
    assert.ok(countOf(gl, 'deleteBuffer') >= 3, 'the old buffers are freed');

    gl.calls.length = 0;
    renderer.render(gl, info);
    assert.equal(countOf(gl, 'bufferData'), 0, 'and then it is quiet again');
  });

  test('two meshes sharing one geometry upload it once', () => {
    const gl = fakeGL();
    const geometry = box();
    const other = createSceneNode('mesh', { position: [2, 0, 0] }, null);
    other.insertBefore(geometry, null);
    other.insertBefore(material('meshBasicMaterial'), null);
    const first = mesh(geometry, material('meshBasicMaterial'));
    // the same geometry node in two meshes is the case the cache is for
    const renderer = new ShaderSceneRenderer(surfaceWith([first, other]));
    renderer.render(gl, info);
    assert.equal(countOf(gl, 'drawElements'), 2, 'both meshes draw');
    assert.ok(countOf(gl, 'bufferData') <= 4, 'one geometry, one upload set');
  });
});

describe('programs', () => {
  test('one material configuration compiles one program, reused per frame', () => {
    const gl = fakeGL();
    const renderer = new ShaderSceneRenderer(
      surfaceWith([
        mesh(box(), material('meshBasicMaterial', { color: '#ff0000' })),
        mesh(box(), material('meshBasicMaterial', { color: '#00ff00' })),
      ]),
    );
    renderer.render(gl, info);
    assert.equal(
      countOf(gl, 'linkProgram'),
      1,
      'colour is a uniform, not a program',
    );

    gl.calls.length = 0;
    renderer.render(gl, info);
    assert.equal(countOf(gl, 'linkProgram'), 0, 'and it is not rebuilt');
  });

  test('the shader declares exactly as many lights as the scene has', () => {
    const twoLights = new ShaderSceneRenderer(
      surfaceWith([
        light('pointLight', { position: [1, 1, 1] }),
        light('pointLight', { position: [2, 2, 2] }),
        mesh(box(), material('meshLambertMaterial')),
      ]),
    );
    const gl = fakeGL();
    twoLights.render(gl, info);
    const fragment = gl.shaderSources.find(
      (s) => s.type === gl.FRAGMENT_SHADER,
    );
    assert.match(
      fragment.source,
      /lightPosition\[2\]/,
      'two light slots, not a fixed eight — ES 2 guarantees few uniform vectors',
    );
  });

  test('an unlit material compiles no lighting code at all', () => {
    const gl = fakeGL();
    new ShaderSceneRenderer(
      surfaceWith([
        light('pointLight', {}),
        mesh(box(), material('meshBasicMaterial')),
      ]),
    ).render(gl, info);
    const fragment = gl.shaderSources.find(
      (s) => s.type === gl.FRAGMENT_SHADER,
    );
    assert.doesNotMatch(fragment.source, /lightPosition/);
  });

  test('phong adds a specular term that lambert does not have', () => {
    const sourceFor = (kind) => {
      const gl = fakeGL();
      new ShaderSceneRenderer(
        surfaceWith([light('pointLight', {}), mesh(box(), material(kind))]),
      ).render(gl, info);
      return gl.shaderSources.find((s) => s.type === gl.FRAGMENT_SHADER).source;
    };
    assert.match(sourceFor('meshPhongMaterial'), /shininess/);
    assert.doesNotMatch(sourceFor('meshLambertMaterial'), /shininess/);
  });

  test('a lit material with no lights in the scene draws flat', () => {
    const gl = fakeGL();
    new ShaderSceneRenderer(
      surfaceWith([mesh(box(), material('meshLambertMaterial'))]),
    ).render(gl, info);
    const fragment = gl.shaderSources.find(
      (s) => s.type === gl.FRAGMENT_SHADER,
    );
    // otherwise every unlit-by-accident scene renders black, which reads as
    // "3D is broken" rather than "you forgot a light"
    assert.doesNotMatch(fragment.source, /lightPosition/);
  });
});

describe('shaderMaterial', () => {
  const VERTEX = 'void main() { gl_Position = vec4(position, 1.0); }';
  const FRAGMENT = 'void main() { gl_FragColor = vec4(1.0); }';

  test("three.js's matrices and attributes are declared for the user", () => {
    const gl = fakeGL();
    new ShaderSceneRenderer(
      surfaceWith([
        mesh(
          box(),
          material('shaderMaterial', {
            vertexShader: VERTEX,
            fragmentShader: FRAGMENT,
          }),
        ),
      ]),
    ).render(gl, info);
    const vertex = gl.shaderSources.find((s) => s.type === gl.VERTEX_SHADER);
    for (const name of [
      'projectionMatrix',
      'modelViewMatrix',
      'normalMatrix',
      'cameraPosition',
      'attribute vec3 position',
      'attribute vec3 normal',
      'attribute vec2 uv',
    ]) {
      assert.ok(
        vertex.source.includes(name),
        `a shader copied from three.js expects ${name} to be declared`,
      );
    }
    assert.ok(vertex.source.includes(VERTEX), 'and the user code is there');
  });

  test('both stages get the same default precision', () => {
    // GLSL ES defaults float to highp in a vertex shader and to nothing in a
    // fragment shader, so a uniform used in both — `uniform float uTime`, the
    // most ordinary thing a shader does — fails to *link* with "mismatching
    // precision qualifiers" unless a default is injected into both. This
    // reached a screenshot before it was caught, hence the test.
    const gl = fakeGL();
    new ShaderSceneRenderer(
      surfaceWith([
        mesh(
          box(),
          material('shaderMaterial', {
            vertexShader: 'uniform float uTime;\nvoid main() {}',
            fragmentShader: 'uniform float uTime;\nvoid main() {}',
          }),
        ),
      ]),
    ).render(gl, info);
    const precisionOf = (type) => {
      const source = gl.shaderSources.find((s) => s.type === type).source;
      return source.match(/precision\s+(\w+)\s+float\s*;/)?.[1];
    };
    const vertex = precisionOf(gl.VERTEX_SHADER);
    assert.ok(vertex, 'the vertex shader declares a default precision');
    assert.equal(
      vertex,
      precisionOf(gl.FRAGMENT_SHADER),
      'and it is the same one the fragment shader gets',
    );
  });

  test('a generated material declares one too, for the same reason', () => {
    const gl = fakeGL();
    new ShaderSceneRenderer(
      surfaceWith([mesh(box(), material('meshPhongMaterial'))]),
    ).render(gl, info);
    const has = (type) =>
      /precision\s+\w+\s+float\s*;/.test(
        gl.shaderSources.find((s) => s.type === type).source,
      );
    assert.ok(has(gl.VERTEX_SHADER) && has(gl.FRAGMENT_SHADER));
  });

  test('rawShaderMaterial declares nothing, as in three.js', () => {
    const gl = fakeGL();
    new ShaderSceneRenderer(
      surfaceWith([
        mesh(
          box(),
          material('rawShaderMaterial', {
            vertexShader: VERTEX,
            fragmentShader: FRAGMENT,
          }),
        ),
      ]),
    ).render(gl, info);
    const vertex = gl.shaderSources.find((s) => s.type === gl.VERTEX_SHADER);
    assert.equal(vertex.source, VERTEX);
  });

  test('uniforms go out by the setter their value implies', () => {
    const gl = fakeGL();
    new ShaderSceneRenderer(
      surfaceWith([
        mesh(
          box(),
          material('shaderMaterial', {
            vertexShader: VERTEX,
            fragmentShader: FRAGMENT,
            uniforms: {
              uTime: { value: 1.5 },
              uColor: { value: [1, 0, 0] },
              uPair: { value: [1, 2] },
              uQuad: { value: [1, 2, 3, 4] },
              uMatrix: { value: new Float32Array(16) },
              uFlag: { value: true },
            },
          }),
        ),
      ]),
    ).render(gl, info);
    const sent = (name) =>
      gl.calls.find((c) => c.args[0] === `u:${name}`)?.name;
    assert.equal(sent('uTime'), 'uniform1f');
    assert.equal(sent('uColor'), 'uniform3fv');
    assert.equal(sent('uPair'), 'uniform2fv');
    assert.equal(sent('uQuad'), 'uniform4fv');
    assert.equal(sent('uMatrix'), 'uniformMatrix4fv');
    assert.equal(sent('uFlag'), 'uniform1i');
  });

  test("a bare value works as well as three.js's { value } wrapper", () => {
    const gl = fakeGL();
    new ShaderSceneRenderer(
      surfaceWith([
        mesh(
          box(),
          material('shaderMaterial', {
            vertexShader: VERTEX,
            fragmentShader: FRAGMENT,
            uniforms: { uTime: 2 },
          }),
        ),
      ]),
    ).render(gl, info);
    assert.equal(
      gl.calls.find((c) => c.args[0] === 'u:uTime')?.name,
      'uniform1f',
    );
  });

  test('changing a uniform does not recompile the program', () => {
    const gl = fakeGL();
    const mat = material('shaderMaterial', {
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: { uTime: { value: 0 } },
    });
    const renderer = new ShaderSceneRenderer(surfaceWith([mesh(box(), mat)]));
    renderer.render(gl, info);

    gl.calls.length = 0;
    mat.applyProps({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: { uTime: { value: 1 } },
    });
    renderer.render(gl, info);
    assert.equal(countOf(gl, 'linkProgram'), 0, 'per-frame uniforms are free');
  });
});

describe('a shader that will not build', () => {
  const broken = () =>
    surfaceWith(
      [
        mesh(
          box(),
          material('shaderMaterial', {
            vertexShader: 'nonsense',
            fragmentShader: 'nonsense',
          }),
        ),
      ],
      {},
    );

  test('is reported once, with the compiler log, and does not throw', () => {
    const gl = fakeGL({ compileFails: true });
    const errors = [];
    const surface = broken();
    surface.props.onError = (err) => errors.push(err);
    const renderer = new ShaderSceneRenderer(surface);

    renderer.render(gl, info);
    renderer.render(gl, info);
    renderer.render(gl, info);

    assert.equal(errors.length, 1, 'once, not once per frame');
    assert.equal(errors[0].code, 'GL_SHADER_FAILED');
    assert.match(
      errors[0].message,
      /syntax error/,
      'the compiler log is in it',
    );
    assert.equal(countOf(gl, 'drawElements'), 0, 'and nothing is drawn');
  });

  test('a link failure is reported the same way', () => {
    const gl = fakeGL({ linkFails: true });
    const errors = [];
    const surface = broken();
    surface.props.onError = (err) => errors.push(err);
    new ShaderSceneRenderer(surface).render(gl, info);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /link failed/);
  });
});

describe('draw state follows the material', () => {
  const stateFor = (props) => {
    const gl = fakeGL();
    new ShaderSceneRenderer(
      surfaceWith([mesh(box(), material('meshBasicMaterial', props))]),
    ).render(gl, info);
    return {
      enabled: named(gl, 'enable').map((c) => c.args[0]),
      disabled: named(gl, 'disable').map((c) => c.args[0]),
      depthMask: named(gl, 'depthMask').map((c) => c.args[0]),
      cullFace: named(gl, 'cullFace').map((c) => c.args[0]),
      gl,
    };
  };

  test('an opaque material writes depth and culls the back', () => {
    const state = stateFor({ color: '#ffffff' });
    assert.ok(state.disabled.includes(state.gl.BLEND));
    assert.deepEqual(state.depthMask, [true]);
    assert.deepEqual(state.cullFace, [state.gl.BACK]);
  });

  test('a transparent one blends and stops writing depth', () => {
    const state = stateFor({ transparent: true, opacity: 0.5 });
    assert.ok(state.enabled.includes(state.gl.BLEND));
    // a translucent surface that wrote depth would hide what is behind it
    assert.deepEqual(state.depthMask, [false]);
  });

  test('opacity below one is enough on its own', () => {
    const state = stateFor({ opacity: 0.25 });
    assert.ok(state.enabled.includes(state.gl.BLEND));
  });

  test('side="double" turns culling off', () => {
    const state = stateFor({ side: 'double' });
    assert.ok(state.disabled.includes(state.gl.CULL_FACE));
  });

  test('side="back" culls the front instead', () => {
    const state = stateFor({ side: 'back' });
    assert.deepEqual(state.cullFace, [state.gl.FRONT]);
  });
});

describe('textures', () => {
  const image = { width: 2, height: 2, data: new Uint8Array(16) };

  test('an image is uploaded once and rebound afterwards', () => {
    const gl = fakeGL();
    const renderer = new ShaderSceneRenderer(
      surfaceWith([mesh(box(), material('meshBasicMaterial', { map: image }))]),
    );
    renderer.render(gl, info);
    assert.equal(countOf(gl, 'texImage2D'), 1);

    gl.calls.length = 0;
    renderer.render(gl, info);
    assert.equal(countOf(gl, 'texImage2D'), 0, 'the pixels do not go twice');
    assert.equal(countOf(gl, 'bindTexture'), 1, 'it is rebound');
  });

  test('a non-power-of-two image clamps instead of repeating', () => {
    const gl = fakeGL();
    new ShaderSceneRenderer(
      surfaceWith([
        mesh(
          box(),
          material('meshBasicMaterial', {
            map: { width: 3, height: 5, data: new Uint8Array(60) },
          }),
        ),
      ]),
    ).render(gl, info);
    const wraps = named(gl, 'texParameteri')
      .filter((c) => c.args[1] === gl.TEXTURE_WRAP_S)
      .map((c) => c.args[2]);
    // ES 2 will not repeat a NPOT texture; it samples black instead
    assert.deepEqual(wraps, [gl.CLAMP_TO_EDGE]);
  });

  test('the shader samples a map only when there is one', () => {
    const sourceFor = (props) => {
      const gl = fakeGL();
      new ShaderSceneRenderer(
        surfaceWith([mesh(box(), material('meshBasicMaterial', props))]),
      ).render(gl, info);
      return gl.shaderSources.find((s) => s.type === gl.FRAGMENT_SHADER).source;
    };
    assert.match(sourceFor({ map: image }), /texture2D/);
    assert.doesNotMatch(sourceFor({}), /texture2D/);
  });
});

describe('resources', () => {
  test('forget frees a removed geometry buffers', () => {
    const gl = fakeGL();
    const geometry = box();
    const renderer = new ShaderSceneRenderer(
      surfaceWith([mesh(geometry, material('meshBasicMaterial'))]),
    );
    renderer.render(gl, info);
    gl.calls.length = 0;
    renderer.forget(gl, geometry);
    assert.ok(countOf(gl, 'deleteBuffer') >= 3);
    assert.equal(renderer.geometries.size, 0);
  });

  test('dispose frees buffers, programs and textures', () => {
    const gl = fakeGL();
    const renderer = new ShaderSceneRenderer(
      surfaceWith([
        mesh(
          box(),
          material('meshBasicMaterial', {
            map: { width: 2, height: 2, data: new Uint8Array(16) },
          }),
        ),
      ]),
    );
    renderer.render(gl, info);
    gl.calls.length = 0;
    renderer.dispose(gl);
    assert.ok(countOf(gl, 'deleteBuffer') >= 3);
    assert.equal(countOf(gl, 'deleteProgram'), 1);
    assert.equal(countOf(gl, 'deleteTexture'), 1);
    assert.equal(renderer.geometries.size, 0);
    assert.equal(renderer.programs.size, 0);
  });
});

describe('the scene graph', () => {
  test('a hidden mesh is not drawn', () => {
    const gl = fakeGL();
    const node = mesh(box(), material('meshBasicMaterial'));
    node.applyProps({ visible: false });
    new ShaderSceneRenderer(surfaceWith([node])).render(gl, info);
    assert.equal(countOf(gl, 'drawElements'), 0);
  });

  test('a group composes its children transforms', () => {
    const gl = fakeGL();
    const group = createSceneNode('group', { position: [10, 0, 0] }, null);
    const child = mesh(box(), material('meshBasicMaterial'), {
      position: [1, 0, 0],
    });
    group.insertBefore(child, null);
    new ShaderSceneRenderer(surfaceWith([group])).render(gl, info);
    assert.equal(countOf(gl, 'drawElements'), 1);
    // the world matrix recorded for picking is the composed one
    assert.equal(child._world[12], 11);
  });

  test('leaves behind what picking needs', () => {
    // ScenePointer reads surface.scene.camera and raycast3d reads mesh._world,
    // so both renderers owe the same two things — rays are cast against the
    // frame that is actually on screen (src/pointer3d.js, src/raycast3d.js)
    const gl = fakeGL();
    const node = mesh(box(), material('meshBasicMaterial'), {
      position: [2, 0, 0],
    });
    const renderer = new ShaderSceneRenderer(surfaceWith([node]));
    renderer.render(gl, info);
    assert.ok(renderer.camera.projection, 'a projection matrix');
    assert.ok(renderer.camera.view, 'a view matrix');
    assert.equal(renderer.camera.width, info.width);
    assert.equal(node._world[12], 2, 'the world matrix that was drawn');
  });

  test('an empty scene draws nothing and says so', () => {
    const gl = fakeGL();
    assert.equal(
      new ShaderSceneRenderer(surfaceWith([])).render(gl, info),
      false,
    );
    assert.equal(gl.calls.length, 0);
  });
});

describe('a GL context that is too old', () => {
  test('says so once, instead of throwing from inside a draw call', () => {
    // ntk passes the addon's table straight through, so a context is only as
    // complete as the installed x11-dri — and npm will nest an old copy under
    // node_modules/ntk when its declared range asks for one. Without this the
    // symptom is `TypeError: gl.uniform3fv is not a function`.
    const gl = fakeGL();
    delete gl.uniform3fv;
    delete gl.depthMask;
    const errors = [];
    const surface = surfaceWith([mesh(box(), material('meshBasicMaterial'))], {
      onError: (err) => errors.push(err),
    });
    const renderer = new ShaderSceneRenderer(surface);

    assert.equal(renderer.render(gl, info), false);
    assert.equal(renderer.render(gl, info), false);
    assert.equal(errors.length, 1, 'reported once, not once per frame');
    assert.match(errors[0].message, /uniform3fv/, 'names what is missing');
    assert.match(errors[0].message, /x11-dri/, 'and what to upgrade');
    assert.match(errors[0].message, /npm ls x11-dri/, 'and how to check');
    assert.equal(countOf(gl, 'drawElements'), 0);
  });
});

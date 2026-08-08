// `<points>`, `<line*>` and `<instancedMesh>` — the drawables that are not
// triangles, asserted against **both** renderers.
//
// One scene, two backends, and each has to do the equivalent thing in its own
// idiom: the fixed-function one compiles a display list opened with the right
// `Begin` mode, the shader one draws with the matching ES 2 mode. Testing
// them side by side is the point — these elements exist to be portable, and a
// divergence is exactly the bug worth catching.
//
// Both renderers only ever touch `gl`, so a recording fake is the whole
// environment: no X server, no GPU, no addon.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { lookAt, perspective } from '../src/mat4.js';
import { raycast } from '../src/raycast3d.js';
import { SceneRenderer, createSceneNode } from '../src/scene3d.js';
import { ShaderSceneRenderer } from '../src/scene3d-shader.js';

/** A `gl` recording every call, for whichever renderer. */
function fakeGL(extra = {}) {
  const calls = [];
  let next = 1;
  const gl = {
    calls,
    shaderSources: [],
    // fixed-function names
    POINTS: 0x0000,
    LINES: 0x0001,
    LINE_LOOP: 0x0002,
    LINE_STRIP: 0x0003,
    TRIANGLES: 0x0004,
    COMPILE: 0x1300,
    FRONT_AND_BACK: 0x0408,
    LINE: 0x1b01,
    FILL: 0x1b02,
    // shared constants the shader renderer reads
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
    ...extra,
  };
  const record =
    (name, result) =>
    (...args) => {
      calls.push({ name, args });
      return typeof result === 'function' ? result(...args) : result;
    };
  for (const name of [
    // fixed function
    'NewList',
    'EndList',
    'DeleteLists',
    'Begin',
    'End',
    'Vertex3f',
    'Normal3f',
    'TexCoord2f',
    'Color3f',
    'Color4f',
    'CallList',
    'PushMatrix',
    'PopMatrix',
    'MultMatrixf',
    'LoadIdentity',
    'MatrixMode',
    'Enable',
    'Disable',
    'PointSize',
    'LineWidth',
    'PolygonMode',
    'CullFace',
    'ShadeModel',
    'BlendFunc',
    'DepthFunc',
    'Lightfv',
    'LightModelf',
    'Materialfv',
    'Materialf',
    // ES 2
    'enable',
    'disable',
    'depthFunc',
    'depthMask',
    'cullFace',
    'blendFunc',
    'lineWidth',
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
    'uniform3fv',
    'uniform4fv',
    'uniformMatrix3fv',
    'uniformMatrix4fv',
    'attachShader',
    'linkProgram',
    'deleteShader',
    'deleteProgram',
    'compileShader',
  ]) {
    gl[name] = record(name);
  }
  gl.MatrixMode = record('MatrixMode');
  gl.PROJECTION = 0x1701;
  gl.MODELVIEW = 0x1700;
  gl.COLOR_BUFFER_BIT = 0x4000;
  gl.createBuffer = record('createBuffer', () => ({ id: next++ }));
  gl.createProgram = record('createProgram', () => ({ id: next++ }));
  gl.createShader = record('createShader', (type) => ({ id: next++, type }));
  gl.shaderSource = (shader, source) => {
    calls.push({ name: 'shaderSource', args: [shader, source] });
    gl.shaderSources.push({ type: shader.type, source });
  };
  gl.getShaderParameter = () => true;
  gl.getProgramParameter = () => true;
  gl.getShaderInfoLog = () => '';
  gl.getProgramInfoLog = () => '';
  gl.getUniformLocation = (_p, name) => `u:${name}`;
  gl.getAttribLocation = (_p, name) =>
    ({ position: 0, normal: 1, uv: 2 })[name] ?? -1;
  return gl;
}

const named = (gl, name) => gl.calls.filter((c) => c.name === name);
const countOf = (gl, name) => named(gl, name).length;
const info = { width: 200, height: 100 };
const surfaceWith = (children, props = {}) => ({ children, props });

/** A ring of loose vertices — a point cloud or a closed line, as asked. */
const RING = (n = 8) => {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push(Math.cos(a), Math.sin(a), 0);
  }
  return out;
};

function drawable(kind, geometry, material, props = {}) {
  const node = createSceneNode(kind, props, null);
  node.insertBefore(geometry, null);
  node.insertBefore(material, null);
  return node;
}

const buffer = (position) =>
  createSceneNode('bufferGeometry', { position }, null);
const box = () => createSceneNode('boxGeometry', { args: [1, 1, 1] }, null);
const material = (kind, props = {}) => createSceneNode(kind, props, null);

/** Render one scene through both renderers and hand back both recordings. */
function bothBackends(children, props = {}) {
  const indirect = fakeGL();
  new SceneRenderer(surfaceWith(children(), props)).render(indirect, info);
  const direct = fakeGL();
  new ShaderSceneRenderer(surfaceWith(children(), props)).render(direct, info);
  return { indirect, direct };
}

describe('<points>', () => {
  const scene = () => [
    drawable(
      'points',
      buffer(RING()),
      material('pointsMaterial', {
        color: '#ffd166',
        size: 6,
      }),
    ),
  ];

  test('assembles vertices as points on both backends', () => {
    const { indirect, direct } = bothBackends(scene);
    assert.deepEqual(
      named(indirect, 'Begin').map((c) => c.args[0]),
      [indirect.POINTS],
      'the display list opens with GL_POINTS',
    );
    assert.deepEqual(
      named(direct, 'drawArrays').map((c) => c.args[0]),
      [direct.POINTS],
      'and the draw call asks for GL_POINTS',
    );
  });

  test('one vertex is one dot — the triangle index is not replayed', () => {
    const gl = fakeGL();
    // a geometry with an index, drawn as points: replaying the index would
    // draw shared vertices several times over
    const geometry = createSceneNode(
      'bufferGeometry',
      { position: RING(4), index: [0, 1, 2, 0, 2, 3] },
      null,
    );
    new SceneRenderer(
      surfaceWith([drawable('points', geometry, material('pointsMaterial'))]),
    ).render(gl, info);
    assert.equal(countOf(gl, 'Vertex3f'), 4, 'four vertices, four dots');
  });

  test('size reaches each backend the only way it can', () => {
    const { indirect, direct } = bothBackends(scene);
    // fixed-function has glPointSize; ES 2 has none, so the vertex shader
    // writes gl_PointSize from a uniform
    assert.deepEqual(
      named(indirect, 'PointSize').map((c) => c.args[0]),
      [6],
    );
    const vertex = direct.shaderSources.find(
      (s) => s.type === direct.VERTEX_SHADER,
    );
    assert.match(vertex.source, /gl_PointSize = pointSize/);
    assert.deepEqual(
      named(direct, 'uniform1f')
        .filter((c) => c.args[0] === 'u:pointSize')
        .map((c) => c.args[1]),
      [6],
    );
  });

  test('no normals are derived for a cloud nothing shades', () => {
    const geometry = buffer(RING(64));
    new SceneRenderer(
      surfaceWith([drawable('points', geometry, material('pointsMaterial'))]),
    ).render(fakeGL(), info);
    // 64 loose vertices are not 21 triangles; computing face normals over
    // them is a pass and an allocation spent on data no shader reads
    assert.equal(geometry.data({ normals: false }).normals.length, 0);
  });
});

describe('<line>, <lineSegments>, <lineLoop>', () => {
  const lineScene = (kind) => () => [
    drawable(
      kind,
      buffer(RING()),
      material('lineBasicMaterial', {
        color: '#4ecdc4',
        linewidth: 3,
      }),
    ),
  ];

  test('each spelling picks its own primitive, the same way on both', () => {
    for (const [kind, fixed, es2] of [
      ['line', 'LINE_STRIP', 'LINE_STRIP'],
      ['lineSegments', 'LINES', 'LINES'],
      ['lineLoop', 'LINE_LOOP', 'LINE_LOOP'],
    ]) {
      const { indirect, direct } = bothBackends(lineScene(kind));
      assert.deepEqual(
        named(indirect, 'Begin').map((c) => c.args[0]),
        [indirect[fixed]],
        `${kind} compiles as ${fixed}`,
      );
      assert.deepEqual(
        named(direct, 'drawArrays').map((c) => c.args[0]),
        [direct[es2]],
        `${kind} draws as ${es2}`,
      );
    }
  });

  test('linewidth is applied on both', () => {
    const { indirect, direct } = bothBackends(lineScene('lineSegments'));
    assert.deepEqual(
      named(indirect, 'LineWidth').map((c) => c.args[0]),
      [3],
    );
    assert.deepEqual(
      named(direct, 'lineWidth').map((c) => c.args[0]),
      [3],
    );
  });
});

describe('<instancedMesh>', () => {
  const instances = [
    { position: [-1, 0, 0], color: '#ff0000' },
    { position: [0, 0, 0] },
    { position: [1, 0, 0], color: '#0000ff' },
  ];
  const scene = () => [
    drawable('instancedMesh', box(), material('meshBasicMaterial'), {
      instances,
    }),
  ];

  test('the geometry is uploaded once and drawn per instance', () => {
    const { indirect, direct } = bothBackends(scene);
    // one display list, replayed three times
    assert.equal(countOf(indirect, 'NewList'), 1);
    assert.equal(countOf(indirect, 'CallList'), 3);
    // one buffer set, three draws
    assert.equal(countOf(direct, 'drawElements'), 3);
    assert.ok(
      countOf(direct, 'bufferData') <= 4,
      'positions, normals, uvs and one index — not one set per instance',
    );
  });

  test('each instance is drawn at its own transform', () => {
    const { indirect, direct } = bothBackends(scene);
    // fixed function pushes a matrix per instance, on top of the node's own
    assert.equal(countOf(indirect, 'PushMatrix'), 4);
    assert.equal(countOf(indirect, 'PopMatrix'), 4);
    // the shader backend sends a model-view matrix per instance
    const models = named(direct, 'uniformMatrix4fv').filter(
      (c) => c.args[0] === 'u:modelMatrix',
    );
    assert.equal(models.length, 3);
    assert.deepEqual(
      models.map((c) => [c.args[2][12], c.args[2][13], c.args[2][14]]),
      [
        [-1, 0, 0],
        [0, 0, 0],
        [1, 0, 0],
      ],
      'the translations are the instances',
    );
  });

  test('a per-instance colour overrides the material, and does not leak', () => {
    const { indirect, direct } = bothBackends(scene);
    // the material's own colour, then one per instance: colour is GL state
    // and PopMatrix does not restore it, so the middle instance has to be
    // told the base colour or it inherits the red before it
    assert.deepEqual(
      named(indirect, 'Color3f').map((c) => c.args.slice(0, 3)),
      [
        [1, 1, 1],
        [1, 0, 0],
        [1, 1, 1],
        [0, 0, 1],
      ],
    );
    const diffuse = named(direct, 'uniform3fv')
      .filter((c) => c.args[0] === 'u:diffuse')
      .map((c) => [...c.args[1]]);
    // the material's own colour, then red, then back to it, then blue
    assert.deepEqual(diffuse.at(-3), [1, 0, 0]);
    assert.deepEqual(diffuse.at(-1), [0, 0, 1]);
    assert.deepEqual(
      diffuse.at(-2),
      [1, 1, 1],
      'an instance with no colour gets the material back, not the last one',
    );
  });

  test('an empty instances array draws nothing but does not throw', () => {
    const empty = () => [
      drawable('instancedMesh', box(), material('meshBasicMaterial'), {
        instances: [],
      }),
    ];
    const { indirect, direct } = bothBackends(empty);
    assert.equal(countOf(indirect, 'CallList'), 0);
    assert.equal(countOf(direct, 'drawElements'), 0);
  });
});

describe('one geometry, two primitives', () => {
  test('is two compilations, not one reused wrongly', () => {
    const geometry = buffer(RING());
    const gl = fakeGL();
    new SceneRenderer(
      surfaceWith([
        drawable('points', geometry, material('pointsMaterial')),
        drawable('lineLoop', geometry, material('lineBasicMaterial')),
      ]),
    ).render(gl, info);
    assert.equal(countOf(gl, 'NewList'), 2, 'a list per primitive');
    assert.deepEqual(
      named(gl, 'Begin').map((c) => c.args[0]),
      [gl.POINTS, gl.LINE_LOOP],
    );

    const direct = fakeGL();
    new ShaderSceneRenderer(
      surfaceWith([
        drawable('points', geometry, material('pointsMaterial')),
        drawable('lineLoop', geometry, material('lineBasicMaterial')),
      ]),
    ).render(direct, info);
    assert.deepEqual(
      named(direct, 'drawArrays').map((c) => c.args[0]),
      [direct.POINTS, direct.LINE_LOOP],
    );
  });
});

describe('picking', () => {
  const camera = {
    width: 200,
    height: 200,
    projection: perspective(50, 1, 0.1, 100),
    view: lookAt([0, 0, 5], [0, 0, 0], [0, 1, 0]),
  };

  /** Draw once so every node has the world matrix picking reads. */
  function drawn(children) {
    const surface = surfaceWith(children);
    new ShaderSceneRenderer(surface).render(fakeGL(), info);
    return surface;
  }

  test('a plain <mesh> under the pointer is hit', () => {
    const surface = drawn([
      drawable('mesh', box(), material('meshBasicMaterial'), {
        onClick: () => {},
      }),
    ]);
    assert.equal(raycast(surface, 100, 100, camera).length, 1);
  });

  test('<points> and <line> are not — a ray meets no surface there', () => {
    for (const kind of ['points', 'lineLoop']) {
      const surface = drawn([
        drawable(kind, buffer(RING()), material('pointsMaterial'), {
          onClick: () => {},
        }),
      ]);
      assert.equal(
        raycast(surface, 100, 100, camera).length,
        0,
        `${kind} has no triangles for a ray to hit`,
      );
    }
  });

  test('<instancedMesh> is not hit at a transform nothing was drawn at', () => {
    // the node sits at the origin and its instances are off to the sides, so
    // testing the base geometry here would report a hit in empty space
    const surface = drawn([
      drawable('instancedMesh', box(), material('meshBasicMaterial'), {
        instances: [{ position: [-3, 0, 0] }, { position: [3, 0, 0] }],
        onClick: () => {},
      }),
    ]);
    assert.equal(raycast(surface, 100, 100, camera).length, 0);
  });
});

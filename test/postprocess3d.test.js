// `<effectComposer>`: the scene rendered to a texture, then through a chain
// of full-screen passes.
//
// The fake `gl` here is a small state machine rather than a call log, because
// the properties worth asserting are about *state at draw time* — which
// framebuffer a draw lands in, which texture it samples, at what size. The
// one that matters most is that no pass ever samples the target it is
// writing: that is undefined behaviour in GL, it renders as garbage or as
// nothing depending on the driver, and a call log cannot see it.
//
// Hermetic: no X server, no GPU, no addon.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ShaderSceneRenderer } from '../src/scene3d-shader.js';
import { createSceneNode } from '../src/scene3d.js';

const FRAMEBUFFER_COMPLETE = 0x8cd5;
const FRAMEBUFFER_UNSUPPORTED = 0x8cdd;

/**
 * A `gl` that tracks binding state and records every draw with the state in
 * force. Ids are numbered by kind so a mixed-up argument is obvious.
 *
 * `compileFails` is `true` for "no shader builds", or a substring for "the
 * one shader containing this does not" — which is the interesting case, since
 * a chain whose *fallback* also fails cannot show what the fallback does.
 */
function fakeGL({
  incomplete = false,
  compileFails = false,
  withoutFramebuffers = false,
} = {}) {
  const calls = [];
  const draws = [];
  const state = { framebuffer: 0, viewport: null, program: null, unit: 0 };
  const bound = new Map(); // texture unit -> texture id
  const attachments = new Map(); // framebuffer id -> { color, depth }
  const live = { framebuffers: new Set(), textures: new Set(), renderbuffers: new Set(), buffers: new Set() }; // prettier-ignore
  let nextFramebuffer = 100;
  let nextTexture = 200;
  let nextRenderbuffer = 300;
  let nextBuffer = 400;
  let nextProgram = 500;

  const record =
    (name, result) =>
    (...args) => {
      calls.push({ name, args });
      return typeof result === 'function' ? result(...args) : result;
    };

  const gl = {
    calls,
    draws,
    live,
    attachments,
    shaderSources: [],
    TRIANGLES: 4,
    TRIANGLE_STRIP: 5,
    POINTS: 0,
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
    FRAMEBUFFER: 0x8d40,
    RENDERBUFFER: 0x8d41,
    COLOR_ATTACHMENT0: 0x8ce0,
    DEPTH_ATTACHMENT: 0x8d00,
    DEPTH_COMPONENT16: 0x81a5,
    FRAMEBUFFER_COMPLETE,
  };

  for (const name of [
    'enable',
    'disable',
    'depthFunc',
    'depthMask',
    'cullFace',
    'blendFunc',
    'bufferData',
    'enableVertexAttribArray',
    'vertexAttribPointer',
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
    'compileShader',
    'deleteShader',
    'texParameteri',
    'pixelStorei',
    'texImage2D',
    'renderbufferStorage',
    'lineWidth',
  ]) {
    gl[name] = record(name);
  }

  gl.viewport = (x, y, width, height) => {
    calls.push({ name: 'viewport', args: [x, y, width, height] });
    state.viewport = { width, height };
  };
  gl.bindFramebuffer = (target, framebuffer) => {
    calls.push({ name: 'bindFramebuffer', args: [target, framebuffer] });
    state.framebuffer = framebuffer;
  };
  gl.activeTexture = (unit) => {
    calls.push({ name: 'activeTexture', args: [unit] });
    state.unit = unit - gl.TEXTURE0;
  };
  gl.bindTexture = (target, texture) => {
    calls.push({ name: 'bindTexture', args: [target, texture] });
    bound.set(state.unit, texture);
  };
  gl.useProgram = (program) => {
    calls.push({ name: 'useProgram', args: [program] });
    state.program = program;
  };
  gl.bindBuffer = record('bindBuffer');
  gl.bindRenderbuffer = record('bindRenderbuffer');

  const snapshot = (kind, count) => {
    draws.push({
      kind,
      count,
      program: state.program,
      framebuffer: state.framebuffer,
      viewport: state.viewport && { ...state.viewport },
      textures: Object.fromEntries(bound),
    });
  };
  gl.drawArrays = (mode, first, count) => {
    calls.push({ name: 'drawArrays', args: [mode, first, count] });
    snapshot(mode === gl.TRIANGLE_STRIP ? 'quad' : 'arrays', count);
  };
  gl.drawElements = (mode, count) => {
    calls.push({ name: 'drawElements', args: [mode, count] });
    snapshot('elements', count);
  };

  gl.createBuffer = record('createBuffer', () => {
    const id = nextBuffer++;
    live.buffers.add(id);
    return id;
  });
  gl.deleteBuffer = record('deleteBuffer', (id) => live.buffers.delete(id));
  gl.createTexture = record('createTexture', () => {
    const id = nextTexture++;
    live.textures.add(id);
    return id;
  });
  gl.deleteTexture = record('deleteTexture', (id) => live.textures.delete(id));
  gl.createRenderbuffer = record('createRenderbuffer', () => {
    const id = nextRenderbuffer++;
    live.renderbuffers.add(id);
    return id;
  });
  gl.deleteRenderbuffer = record('deleteRenderbuffer', (id) =>
    live.renderbuffers.delete(id),
  );
  gl.createFramebuffer = record('createFramebuffer', () => {
    const id = nextFramebuffer++;
    live.framebuffers.add(id);
    attachments.set(id, { color: null, depth: null });
    return id;
  });
  gl.deleteFramebuffer = record('deleteFramebuffer', (id) =>
    live.framebuffers.delete(id),
  );
  gl.framebufferTexture2D = (target, attachment, textarget, texture) => {
    calls.push({ name: 'framebufferTexture2D', args: [attachment, texture] });
    const entry = attachments.get(state.framebuffer);
    if (entry) entry.color = texture;
  };
  gl.framebufferRenderbuffer = (target, attachment, rbtarget, renderbuffer) => {
    calls.push({ name: 'framebufferRenderbuffer', args: [attachment] });
    const entry = attachments.get(state.framebuffer);
    if (entry) entry.depth = renderbuffer;
  };
  gl.checkFramebufferStatus = () =>
    incomplete ? FRAMEBUFFER_UNSUPPORTED : FRAMEBUFFER_COMPLETE;

  gl.createProgram = record('createProgram', () => nextProgram++);
  gl.deleteProgram = record('deleteProgram');
  gl.createShader = record('createShader', (type) => ({ type }));
  gl.shaderSource = (shader, source) => {
    calls.push({ name: 'shaderSource', args: [shader, source] });
    shader.source = source;
    gl.shaderSources.push({ type: shader.type, source });
  };
  gl.getShaderParameter = (shader) => {
    if (!compileFails) return true;
    if (compileFails === true) return false;
    return !String(shader.source ?? '').includes(compileFails);
  };
  gl.getProgramParameter = () => true;
  gl.getShaderInfoLog = () => 'ERROR: 0:2 undeclared identifier';
  gl.getProgramInfoLog = () => 'link failed';
  gl.getUniformLocation = (program, name) => `${program}:${name}`;
  gl.getAttribLocation = (program, name) =>
    ({ position: 0, normal: 1, uv: 2 })[name] ?? -1;

  if (withoutFramebuffers) {
    for (const name of [
      'createFramebuffer',
      'framebufferTexture2D',
      'checkFramebufferStatus',
    ]) {
      delete gl[name];
    }
  }
  return gl;
}

const info = { width: 200, height: 100 };

function surfaceWith(children, props = {}) {
  return { children, props };
}

function mesh(props = {}) {
  const node = createSceneNode('mesh', props, null);
  node.insertBefore(createSceneNode('boxGeometry', { args: [1, 1, 1] }, null), null); // prettier-ignore
  node.insertBefore(createSceneNode('meshBasicMaterial', {}, null), null);
  return node;
}

function composer(passes, props = {}) {
  const node = createSceneNode('effectComposer', props, null);
  for (const pass of passes) node.insertBefore(pass, null);
  return node;
}

const pass = (kind, props = {}) => createSceneNode(kind, props, null);

/** One whole frame, the way `<glarea>` draws it. */
function frame(renderer, gl, size = info) {
  const bound = renderer.beginFrame(gl, size);
  gl.viewport(0, 0, size.width, size.height);
  renderer.render(gl, size);
  renderer.endFrame(gl, size);
  return bound;
}

/** float32 round-trips through the GPU, so exact equality is the wrong test. */
const near = (actual, expected, what) =>
  assert.ok(
    Math.abs(actual - expected) < 1e-6,
    `${what}: ${actual} is not ${expected}`,
  );

const quads = (gl) => gl.draws.filter((d) => d.kind === 'quad');
const sceneDraws = (gl) => gl.draws.filter((d) => d.kind !== 'quad');
const countOf = (gl, name) => gl.calls.filter((c) => c.name === name).length;

describe('a surface with no composer is untouched', () => {
  test('nothing is rendered to a texture', () => {
    const gl = fakeGL();
    const renderer = new ShaderSceneRenderer(surfaceWith([mesh()]));
    assert.equal(frame(renderer, gl), false);
    assert.equal(countOf(gl, 'createFramebuffer'), 0);
    assert.equal(quads(gl).length, 0);
    // and the scene drew straight into the window
    assert.equal(sceneDraws(gl)[0].framebuffer, 0);
  });

  test('a composer with no passes is the same as no composer', () => {
    const gl = fakeGL();
    const renderer = new ShaderSceneRenderer(
      surfaceWith([mesh(), composer([])]),
    );
    assert.equal(frame(renderer, gl), false);
    assert.equal(countOf(gl, 'createFramebuffer'), 0);
    assert.equal(sceneDraws(gl)[0].framebuffer, 0);
  });

  test('enabled={false} turns the whole chain off', () => {
    const gl = fakeGL();
    const renderer = new ShaderSceneRenderer(
      surfaceWith([mesh(), composer([pass('vignettePass')], { enabled: false })]), // prettier-ignore
    );
    assert.equal(frame(renderer, gl), false);
    assert.equal(sceneDraws(gl)[0].framebuffer, 0);
  });

  test('a disabled pass is skipped, and the rest still run', () => {
    const gl = fakeGL();
    const renderer = new ShaderSceneRenderer(
      surfaceWith([
        mesh(),
        composer([pass('vignettePass', { enabled: false }), pass('fxaaPass')]),
      ]),
    );
    frame(renderer, gl);
    assert.equal(quads(gl).length, 1, 'only the enabled pass drew');
  });
});

describe('the scene goes to a texture and the chain brings it back', () => {
  test('one pass: scene offscreen, pass into the window', () => {
    const gl = fakeGL();
    const renderer = new ShaderSceneRenderer(
      surfaceWith([mesh(), composer([pass('vignettePass')])]),
    );
    assert.equal(frame(renderer, gl), true);

    const scene = sceneDraws(gl);
    assert.equal(scene.length, 1);
    assert.notEqual(scene[0].framebuffer, 0, 'the scene drew offscreen');

    const chain = quads(gl);
    assert.equal(chain.length, 1);
    assert.equal(chain[0].framebuffer, 0, 'the last pass drew into the window');
    // and it sampled exactly what the scene drew
    assert.equal(
      chain[0].textures[0],
      gl.attachments.get(scene[0].framebuffer).color,
    );
  });

  test('the scene target has depth, the ping-pong partner does not', () => {
    const gl = fakeGL();
    const renderer = new ShaderSceneRenderer(
      surfaceWith([mesh(), composer([pass('vignettePass')])]),
    );
    frame(renderer, gl);

    const scene = sceneDraws(gl)[0].framebuffer;
    assert.ok(
      gl.attachments.get(scene).depth,
      'the scene needs a depth buffer',
    );
    const others = [...gl.attachments.keys()].filter((id) => id !== scene);
    assert.equal(others.length, 1, 'two targets, no more');
    assert.equal(
      gl.attachments.get(others[0]).depth,
      null,
      'a full-screen quad has nothing to depth-test against',
    );
  });

  test('the viewport follows the target', () => {
    const gl = fakeGL();
    const renderer = new ShaderSceneRenderer(
      surfaceWith([mesh(), composer([pass('fxaaPass')])]),
    );
    frame(renderer, gl);
    assert.deepEqual(quads(gl)[0].viewport, { width: 200, height: 100 });
  });
});

describe('ping-pong', () => {
  test('three passes alternate targets and end at the window', () => {
    const gl = fakeGL();
    const renderer = new ShaderSceneRenderer(
      surfaceWith([
        mesh(),
        composer([
          pass('vignettePass'),
          pass('fxaaPass'),
          pass('vignettePass', { offset: 0.2 }),
        ]),
      ]),
    );
    frame(renderer, gl);

    const chain = quads(gl);
    assert.equal(chain.length, 3);
    assert.equal(chain[2].framebuffer, 0, 'the last pass draws the window');
    assert.notEqual(chain[0].framebuffer, 0);
    assert.notEqual(chain[1].framebuffer, 0);
    assert.notEqual(
      chain[0].framebuffer,
      chain[1].framebuffer,
      'consecutive passes write different targets',
    );
    // the second pass reads what the first one wrote
    assert.equal(
      chain[1].textures[0],
      gl.attachments.get(chain[0].framebuffer).color,
    );
  });

  test('no pass ever samples the target it is writing', () => {
    const gl = fakeGL();
    const renderer = new ShaderSceneRenderer(
      surfaceWith([
        mesh(),
        composer([
          pass('vignettePass'),
          pass('bloomPass'),
          pass('fxaaPass'),
          pass('vignettePass', { darkness: 0.9 }),
        ]),
      ]),
    );
    frame(renderer, gl);

    const drawn = quads(gl);
    assert.ok(drawn.length >= 7, `four passes, bloom being four: ${drawn.length}`); // prettier-ignore
    for (const draw of drawn) {
      const attached = gl.attachments.get(draw.framebuffer);
      if (!attached) continue; // the window
      for (const [unit, texture] of Object.entries(draw.textures)) {
        assert.notEqual(
          texture,
          attached.color,
          `a pass sampled unit ${unit} from the target it writes ` +
            `(framebuffer ${draw.framebuffer}) — a feedback loop`,
        );
      }
    }
  });
});

describe('<bloomPass>', () => {
  test('is four draws: bright, across, down, composite', () => {
    const gl = fakeGL();
    const renderer = new ShaderSceneRenderer(
      surfaceWith([mesh(), composer([pass('bloomPass')])]),
    );
    frame(renderer, gl);

    const chain = quads(gl);
    assert.equal(chain.length, 4);
    // three programs: one is used twice, for the two blur axes
    const programs = chain.map((d) => d.program);
    assert.equal(new Set(programs).size, 3);
    assert.equal(programs[1], programs[2], 'one blur program, two directions');
    assert.equal(chain[3].framebuffer, 0, 'the composite reaches the window');
  });

  test('blurs at half resolution', () => {
    const gl = fakeGL();
    const renderer = new ShaderSceneRenderer(
      surfaceWith([mesh(), composer([pass('bloomPass')])]),
    );
    frame(renderer, gl);

    const chain = quads(gl);
    for (const step of chain.slice(0, 3)) {
      assert.deepEqual(step.viewport, { width: 100, height: 50 });
    }
    assert.deepEqual(chain[3].viewport, { width: 200, height: 100 });
  });

  test('the composite reads the scene and the blur at once', () => {
    const gl = fakeGL();
    const renderer = new ShaderSceneRenderer(
      surfaceWith([mesh(), composer([pass('bloomPass')])]),
    );
    frame(renderer, gl);

    const chain = quads(gl);
    const composite = chain[3];
    const scene = gl.attachments.get(sceneDraws(gl)[0].framebuffer).color;
    assert.equal(composite.textures[0], scene, 'unit 0 is the original');
    assert.equal(
      composite.textures[1],
      gl.attachments.get(chain[2].framebuffer).color,
      'unit 1 is what the vertical blur wrote',
    );
  });

  test('the two blur directions are separable, not diagonal', () => {
    const gl = fakeGL();
    const renderer = new ShaderSceneRenderer(
      surfaceWith([mesh(), composer([pass('bloomPass', { radius: 2 })])]),
    );
    frame(renderer, gl);

    const directions = gl.calls
      .filter(
        (c) =>
          c.name === 'uniform2fv' && String(c.args[0]).endsWith(':direction'),
      ) // prettier-ignore
      .map((c) => [...c.args[1]]);
    assert.equal(directions.length, 2);
    // radius 2 over a 100x50 half-size target: across, then down
    near(directions[0][0], 2 / 100, 'horizontal step');
    assert.equal(directions[0][1], 0);
    assert.equal(directions[1][0], 0);
    near(directions[1][1], 2 / 50, 'vertical step');
  });

  test('props reach the uniforms', () => {
    const gl = fakeGL();
    const renderer = new ShaderSceneRenderer(
      surfaceWith([
        mesh(),
        composer([pass('bloomPass', { threshold: 0.3, strength: 2.5 })]),
      ]),
    );
    frame(renderer, gl);
    const floats = gl.calls.filter((c) => c.name === 'uniform1f');
    const byName = (suffix) =>
      floats.find((c) => String(c.args[0]).endsWith(suffix))?.args[1];
    assert.equal(byName(':threshold'), 0.3);
    assert.equal(byName(':strength'), 2.5);
  });
});

describe('<shaderPass>', () => {
  const FRAGMENT = `uniform sampler2D tDiffuse;
uniform float uAmount;
uniform vec3 uTint;
varying vec2 vUv;
void main() {
  gl_FragColor = texture2D(tDiffuse, vUv) * vec4(uTint, 1.0) * uAmount;
}`;

  test('runs the given GLSL, with a precision the two stages agree on', () => {
    const gl = fakeGL();
    const renderer = new ShaderSceneRenderer(
      surfaceWith([
        mesh(),
        composer([pass('shaderPass', { fragmentShader: FRAGMENT })]),
      ]),
    );
    frame(renderer, gl);

    const sources = gl.shaderSources.map((s) => s.source);
    const post = sources.filter((s) => s.includes('vUv = position'));
    assert.equal(post.length, 1, 'the full-screen quad vertex shader');
    const fragment = sources.find((s) => s.includes('uAmount'));
    assert.ok(fragment.startsWith('precision highp float;'));
    // both stages, or `varying vec2 vUv` fails to link on a mismatch
    assert.ok(post[0].startsWith('precision highp float;'));
  });

  test('uniforms take the {value} shape and the setter follows the type', () => {
    const gl = fakeGL();
    const renderer = new ShaderSceneRenderer(
      surfaceWith([
        mesh(),
        composer([
          pass('shaderPass', {
            fragmentShader: FRAGMENT,
            uniforms: { uAmount: { value: 0.75 }, uTint: { value: [1, 0, 0.5] } }, // prettier-ignore
          }),
        ]),
      ]),
    );
    frame(renderer, gl);

    const amount = gl.calls.find(
      (c) => c.name === 'uniform1f' && String(c.args[0]).endsWith(':uAmount'),
    );
    assert.equal(amount.args[1], 0.75);
    const tint = gl.calls.find(
      (c) => c.name === 'uniform3fv' && String(c.args[0]).endsWith(':uTint'),
    );
    assert.deepEqual([...tint.args[1]], [1, 0, 0.5]);
  });

  test('resolution, texelSize and time are set for whoever declares them', () => {
    const gl = fakeGL();
    const renderer = new ShaderSceneRenderer(
      surfaceWith([
        mesh(),
        composer([pass('shaderPass', { fragmentShader: FRAGMENT })]),
      ]),
    );
    frame(renderer, gl);

    const vec2s = gl.calls.filter((c) => c.name === 'uniform2fv');
    const named = (suffix) =>
      vec2s.find((c) => String(c.args[0]).endsWith(suffix));
    assert.deepEqual([...named(':resolution').args[1]], [200, 100]);
    const texel = named(':texelSize').args[1];
    near(texel[0], 1 / 200, 'texel width');
    near(texel[1], 1 / 100, 'texel height');
    assert.ok(
      gl.calls.some(
        (c) => c.name === 'uniform1f' && String(c.args[0]).endsWith(':time'),
      ),
    );
  });

  test('editing the source recompiles; changing a uniform does not', () => {
    const gl = fakeGL();
    const node = pass('shaderPass', {
      fragmentShader: FRAGMENT,
      uniforms: { uAmount: { value: 1 } },
    });
    const renderer = new ShaderSceneRenderer(
      surfaceWith([mesh(), composer([node])]),
    );
    frame(renderer, gl);

    gl.calls.length = 0;
    node.applyProps({ fragmentShader: FRAGMENT, uniforms: { uAmount: { value: 0.2 } } }); // prettier-ignore
    frame(renderer, gl);
    assert.equal(countOf(gl, 'createProgram'), 0, 'a uniform is not a rebuild');

    gl.calls.length = 0;
    node.applyProps({ fragmentShader: `${FRAGMENT}\n// changed` });
    frame(renderer, gl);
    assert.equal(countOf(gl, 'createProgram'), 1, 'new source, new program');
  });
});

describe('when something goes wrong the scene still reaches the window', () => {
  test('a pass whose shader will not compile hands the image on', () => {
    const errors = [];
    // only the vignette's own fragment shader is broken
    const gl = fakeGL({ compileFails: 'darkness' });
    const renderer = new ShaderSceneRenderer(
      surfaceWith(
        [mesh(), composer([pass('vignettePass'), pass('fxaaPass')])],
        {
          onError: (err) => errors.push(err),
        },
      ),
    );
    frame(renderer, gl);

    assert.equal(errors.length, 1, 'reported once');
    assert.equal(errors[0].code, 'GL_SHADER_FAILED');
    assert.match(errors[0].message, /vignettePass/);

    // the image goes on down the chain rather than the frame being dropped:
    // a copy in the broken pass's place, then the pass that does work
    const chain = quads(gl);
    assert.equal(chain.length, 2);
    assert.notEqual(chain[0].framebuffer, 0);
    assert.equal(chain[1].framebuffer, 0, 'and it still reaches the window');
    assert.equal(
      chain[1].textures[0],
      gl.attachments.get(chain[0].framebuffer).color,
      'fxaa read what the copy wrote',
    );

    gl.calls.length = 0;
    frame(renderer, gl);
    assert.equal(errors.length, 1, 'and not again every frame');
  });

  test('an incomplete render target skips the chain, not the scene', () => {
    const errors = [];
    const gl = fakeGL({ incomplete: true });
    const renderer = new ShaderSceneRenderer(
      surfaceWith([mesh(), composer([pass('fxaaPass')])], {
        onError: (err) => errors.push(err),
      }),
    );
    assert.equal(frame(renderer, gl), false);

    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, 'GL_POST_TARGET_FAILED');
    assert.equal(sceneDraws(gl)[0].framebuffer, 0, 'the scene drew anyway');
    // nothing half-made is left behind
    assert.equal(gl.live.framebuffers.size, 0);
    assert.equal(gl.live.renderbuffers.size, 0);
  });

  test('a GL without framebuffer objects says so once', () => {
    const errors = [];
    const gl = fakeGL({ withoutFramebuffers: true });
    const renderer = new ShaderSceneRenderer(
      surfaceWith([mesh(), composer([pass('bloomPass')])], {
        onError: (err) => errors.push(err),
      }),
    );
    assert.equal(frame(renderer, gl), false);
    frame(renderer, gl);

    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, 'GL_POST_UNAVAILABLE');
    assert.match(errors[0].message, /npm ls x11-dri/);
    assert.equal(sceneDraws(gl).length, 2, 'both frames drew the scene');
    assert.ok(sceneDraws(gl).every((d) => d.framebuffer === 0));
  });
});

describe('the pipeline is built once and freed on the way out', () => {
  test('a steady frame allocates nothing', () => {
    const gl = fakeGL();
    const renderer = new ShaderSceneRenderer(
      surfaceWith([
        mesh(),
        composer([pass('bloomPass'), pass('vignettePass')]),
      ]),
    );
    frame(renderer, gl);

    gl.calls.length = 0;
    frame(renderer, gl);
    assert.equal(countOf(gl, 'createFramebuffer'), 0);
    assert.equal(countOf(gl, 'createTexture'), 0);
    assert.equal(countOf(gl, 'createProgram'), 0);
    assert.equal(countOf(gl, 'bufferData'), 0, 'not even the quad');
  });

  // What a checkbox does: `{bloom && <bloomPass />}` unmounts the node, and
  // the chain has to be one shorter on the next frame without rebuilding
  // anything that is still good.
  test('adding and removing a pass changes the chain, not the pipeline', () => {
    const gl = fakeGL();
    const bloom = pass('bloomPass');
    const vignette = pass('vignettePass');
    const chain = composer([bloom, vignette]);
    const renderer = new ShaderSceneRenderer(surfaceWith([mesh(), chain]));
    frame(renderer, gl);
    assert.equal(quads(gl).length, 5, 'bloom is four draws, the vignette one');

    gl.calls.length = 0;
    gl.draws.length = 0;
    chain.removeChild(bloom);
    frame(renderer, gl);
    assert.equal(quads(gl).length, 1, 'the vignette alone');
    assert.equal(quads(gl)[0].framebuffer, 0, 'and it is now the last pass');
    assert.equal(countOf(gl, 'createFramebuffer'), 0, 'the targets survive');

    gl.calls.length = 0;
    gl.draws.length = 0;
    chain.insertBefore(bloom, vignette);
    frame(renderer, gl);
    assert.equal(
      quads(gl).length,
      5,
      'and it comes back, ahead of the vignette',
    );
    assert.equal(
      countOf(gl, 'createProgram'),
      0,
      'with its programs still compiled',
    );
  });

  test('a resize retires the targets and makes new ones', () => {
    const gl = fakeGL();
    const renderer = new ShaderSceneRenderer(
      surfaceWith([mesh(), composer([pass('bloomPass')])]),
    );
    frame(renderer, gl);
    const before = new Set(gl.live.framebuffers);
    assert.equal(before.size, 4, 'two full size, two half size for the bloom');

    gl.calls.length = 0;
    frame(renderer, gl, { width: 400, height: 200 });
    for (const id of before) {
      assert.ok(!gl.live.framebuffers.has(id), `${id} was freed`);
    }
    assert.equal(gl.live.framebuffers.size, 4, 'and four new ones exist');
    assert.equal(countOf(gl, 'createProgram'), 0, 'the programs are unchanged');
    assert.deepEqual(quads(gl).at(-1).viewport, { width: 400, height: 200 });
  });

  test('dispose gives everything back', () => {
    const gl = fakeGL();
    const renderer = new ShaderSceneRenderer(
      surfaceWith([mesh(), composer([pass('bloomPass'), pass('fxaaPass')])]),
    );
    frame(renderer, gl);
    assert.ok(gl.live.framebuffers.size > 0);

    renderer.dispose(gl);
    assert.equal(gl.live.framebuffers.size, 0);
    assert.equal(gl.live.renderbuffers.size, 0);
    assert.equal(gl.live.textures.size, 0);
    assert.equal(gl.live.buffers.size, 0, 'including the full-screen quad');
    assert.ok(countOf(gl, 'deleteProgram') >= 4);
  });
});

describe('the draw state a full-screen quad needs', () => {
  test('depth, culling and blending are off, and depth is back on after', () => {
    const gl = fakeGL();
    const renderer = new ShaderSceneRenderer(
      surfaceWith([mesh(), composer([pass('vignettePass')])]),
    );
    frame(renderer, gl);

    const quad = gl.calls.findIndex((c) => c.name === 'drawArrays');
    const before = gl.calls.slice(0, quad);
    const disabled = before
      .filter((c) => c.name === 'disable')
      .map((c) => c.args[0]);
    for (const cap of [gl.DEPTH_TEST, gl.CULL_FACE, gl.BLEND]) {
      assert.ok(disabled.includes(cap), `disabled 0x${cap.toString(16)}`);
    }
    // the next frame's scene needs the depth buffer back
    const after = gl.calls.slice(quad);
    assert.ok(
      after.some((c) => c.name === 'depthMask' && c.args[0] === true),
      'depth writes are restored',
    );
    assert.equal(
      after.filter((c) => c.name === 'bindFramebuffer').at(-1).args[1],
      0,
      'and the window is left bound',
    );
  });
});

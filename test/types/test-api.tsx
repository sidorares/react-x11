/**
 * Type tests for `react-x11/test`. Not run — compiled. The hand-written
 * declarations drift silently otherwise; this is the only thing that catches
 * it (AGENTS.md, "TypeScript declarations").
 */
import React from 'react';
import {
  renderX11,
  cleanup,
  act,
  waitFor,
  screen,
  within,
  fireEvent,
  userEvent,
  pixelAt,
  expectPixel,
  waitForPixel,
  countPixels,
  isNear,
  toRgb,
  toPNG,
  withFrameClock,
  createMockApp,
  windowNodesOf,
  textOf,
  roleOf,
  screenPointOf,
  pointOutsideWindows,
  inspect,
  ownerChainOf,
  sourceOf,
} from '../../src/testing/index.js';
import {
  XK_RETURN,
  XK_ESCAPE,
  keysymOf,
  charOf,
  MOD,
} from '../../src/keysyms.js';

async function suite() {
  const {
    ctx,
    server,
    windowNode,
    window: ntkWindow,
    getByRole,
    getByText,
    queryByText,
    getAllByRole,
    findByTestName,
    getByPlaceholder,
    rerender,
    unmount,
  } = await renderX11(<box style={{ flexGrow: 1 }} />, {
    width: 320,
    height: 240,
    screen: { width: 1280, height: 800 },
    backend: 'xserver',
    fonts: { 'sans-serif': '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf' },
    wrap: true,
    title: 'a test',
    scale: 2,
  });

  // queries return nodes, and the node API is the public one
  const input = getByRole('textbox');
  const _abs: number = input.abs.width;
  void getByText(/hello/, { exact: false });
  void getByText('hello', { selector: 'text' });
  void getByPlaceholder('Your name');
  const _maybe: unknown = queryByText('nothing');
  const _many: number = getAllByRole('button', { name: 'Save' }).length;
  void (await findByTestName('late', { timeout: 500 }));
  void screen.getByRole('button');
  void within(windowNode).queryAllByRole('option');
  const _text: string = textOf(input);
  const _role: string = roleOf(input);
  // the escape hatch, matching on the element name (#252)
  const _gauges = screen.all((n) => n.kind === 'gauge');
  const _kind: string = input.kind;
  void windowNodesOf(windowNode).length;

  // events
  fireEvent.click(input, { button: 1, modifiers: ['Shift'], dx: 2 });
  fireEvent.wheel(input, { deltaY: 3 });
  fireEvent.key(XK_RETURN, { target: input, modifiers: ['Control'] });
  fireEvent.char('a');
  fireEvent.screenClick(10, 10);
  await userEvent.type(input, 'héllo\n', { skipClick: true });
  await userEvent.tab({ shift: true });
  await userEvent.key(XK_ESCAPE);
  await userEvent.clickOutside();
  await userEvent.hover(input);
  const point = screenPointOf(input, { dx: 1 });
  void (point.x + point.y);
  void pointOutsideWindows(input).x;
  // the raw modifier mask, for a test that would rather not name modifiers
  fireEvent.click(input, { modifiers: MOD.Shift | MOD.Control });

  // pixels
  const rgb = await pixelAt(ctx, 1, 1);
  const _r: number = rgb[0];
  await expectPixel(ctx, 1, 1, '#2980b9', { tolerance: 8 });
  await expectPixel(ctx, 1, 1, [41, 128, 185]);
  await waitForPixel(ctx, 1, 1, '#fff', { timeout: 100, interval: 5 });
  void (await countPixels(ctx, { width: 10, height: 10 }, '#000'));
  void isNear(rgb, '#000', 4);
  void toRgb('#abc');
  void (await toPNG(ctx, null, { width: 10, height: 10 }));

  // the clock
  const clock = withFrameClock(0);
  clock.advance(16);
  clock.set(100);
  const _now: number = clock.now;
  clock.restore();

  // components
  const row = getByComponentOf();
  function getByComponentOf() {
    return screen.getByComponent(/^Task/);
  }
  void screen.getAllByComponent('TaskRow').length;
  void screen.queryByComponent((name) => name.startsWith('T'));
  void (await screen.findByComponent('TaskRow', { timeout: 200 }));
  const _chain: string[] = ownerChainOf(row);
  const _source: number | undefined = sourceOf(row)?.line;
  const inspected = await inspect(row);
  const _name: string | null = inspected.name;
  void inspected.props?.label;
  const hook = inspected.hooks[0];
  const _editable: boolean = hook.editable;
  void hook.subHooks.length;
  await inspected.setHook(0, 41);
  await inspected.setHook(0, ['nested', 'deep'], 'zz');

  // keysyms
  const _k: number = keysymOf('é');
  const _c: string = charOf(0xe9);

  // the server is null on the mock backend, so it has to be narrowed
  if (server) server.injectPointerMove(1, 1);
  void ntkWindow?.id;

  await act(() => {});
  await waitFor(() => getByRole('button'));
  await rerender(<box />);
  await unmount();
  await cleanup();
  void createMockApp();
}

// @ts-expect-error — 'popup' is not one of the backends
const _badBackend = renderX11(<box />, { backend: 'popup' });
// @ts-expect-error — a keysym is a number, not a character
const _badKey = fireEvent.key('a');

export default suite;

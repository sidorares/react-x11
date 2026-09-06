// Drag and drop on the cocoa backend — the external transport over
// @windowkit/appkit (>= 0.5): `NSDraggingDestination` on every window's
// hosting view, `NSDraggingSource` from it. The `dropAccept` / `onDrag*` /
// `dragData` prop contract is untouched; what this file owns is the
// translation between AppKit's vocabulary and src/dnd.js's, in both
// directions.
//
// ## The destination
//
// AppKit asks its questions as backend events — `drag-enter`, `drag-over`,
// `drag-exit`, `drag-perform` — and expects the answer **during the
// callback**: `setDropResponse` from inside the event is what
// `draggingEntered:` returns. `DropSession._overAt` is synchronous (the
// `onDragOver` chance included), so the answer is in hand before the
// callback ends. The session is driven through its local entry points —
// the ones an in-process `DragSession` uses — with an offer flagged
// `external`, so the path diffing, `:drag-over`, `dropAccept` matching and
// the handler dispatch are the one implementation.
//
// The payload is read **during `drag-perform`** — the pasteboard is the
// source's promise and a source may withdraw it once its session has ended
// — so every representation on offer is read then, and `getData` answers
// from that. A Finder drag of three files is three items of one
// `public.file-url` each; they become one `text/uri-list`.
//
// ## The source
//
// Once the renderer's own threshold says a press is a drag, `beginDrag`
// hands the gesture to AppKit, which tracks it everywhere from there: the
// pointer's `mousemove`/`mouseup` stop arriving, `drag-session-moved` is the
// motion and `drag-session-ended` the release. A drop on one of our own
// windows comes back through that window's destination events with
// `local: true` — and those are routed to the live `DragSession` rather than
// the pasteboard, so an in-app drop still gets `e.items` by reference and
// `e.source === 'internal'`, the contract the X11 transport keeps. Other
// applications read the pasteboard, where a thunk is a promise the bridge
// asks `provide` to keep.
//
// ## Types
//
// Pasteboard types are UTIs; react-x11's vocabulary is MIME and X atoms
// (src/transfer.js). The common ones map by table; anything else goes
// through the OS's own database (`pasteboardTypeForMIME`, whose `dyn.*`
// identifier for a MIME type no declared type claims is computed alike by
// every process — how `application/x-myapp-…` travels between two react-x11
// apps) and back (`pasteboardTypeInfo`).
import { runWithPriority, DiscreteEventPriority } from '../priority.js';
import {
  TEXT_TARGETS,
  TYPE_GROUPS,
  parseUriList,
  resolveType,
} from '../transfer.js';

const UTI_TO_MIME = Object.freeze({
  'public.file-url': 'text/uri-list',
  'public.url': 'text/uri-list',
  'public.utf8-plain-text': 'text/plain;charset=utf-8',
  'public.plain-text': 'text/plain',
  'public.html': 'text/html',
  'public.rtf': 'text/rtf',
  'public.png': 'image/png',
  'public.jpeg': 'image/jpeg',
  'public.tiff': 'image/tiff',
  'public.svg-image': 'image/svg+xml',
  'public.json': 'application/json',
});

const MIME_TO_UTI = Object.freeze({
  'text/uri-list': 'public.file-url',
  'text/plain;charset=utf-8': 'public.utf8-plain-text',
  'text/plain': 'public.utf8-plain-text',
  UTF8_STRING: 'public.utf8-plain-text',
  STRING: 'public.utf8-plain-text',
  TEXT: 'public.utf8-plain-text',
  'text/html': 'public.html',
  'text/rtf': 'public.rtf',
  'image/png': 'public.png',
  'image/jpeg': 'public.jpeg',
  'image/tiff': 'public.tiff',
  'image/svg+xml': 'public.svg-image',
  'application/json': 'public.json',
});

/** The pasteboard types every window takes; concrete `dropAccept` types add
 * to them (`CocoaDropTransport.refreshTypes`). */
export const BASE_DROP_UTIS = Object.freeze([
  'public.file-url',
  'public.url',
  'public.utf8-plain-text',
  'public.plain-text',
  'public.html',
  'public.rtf',
  'public.png',
  'public.jpeg',
  'public.tiff',
]);

const isTextual = (uti, mime) =>
  uti.startsWith('public.') && /text/.test(uti) ? true : /^text\//i.test(mime);

export function mimeFromUti(uti, native) {
  if (UTI_TO_MIME[uti]) return UTI_TO_MIME[uti];
  if (!uti.startsWith('dyn.') && !uti.includes('.')) return null;
  try {
    const info = native.pasteboardTypeInfo?.(uti);
    return typeof info?.mime === 'string' && info.mime ? info.mime : null;
  } catch {
    return null;
  }
}

export function utiFromMime(mime, native) {
  if (MIME_TO_UTI[mime]) return MIME_TO_UTI[mime];
  // an X atom name is not a MIME type; nothing on a pasteboard is called it
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+/i.test(mime)) return null;
  try {
    const uti = native.pasteboardTypeForMIME?.(mime.replace(/;.*$/, ''));
    return typeof uti === 'string' && uti ? uti : null;
  } catch {
    return null;
  }
}

/** What a pasteboard's UTIs are in react-x11's vocabulary, best first. */
export function offeredTypes(utis, native) {
  const out = [];
  const add = (t) => t && !out.includes(t) && out.push(t);
  for (const uti of utis ?? []) {
    const mime = mimeFromUti(uti, native);
    add(mime);
    // the plain name beside the charset one, so `text/plain` in a
    // `dropAccept` matches what every macOS text drag offers
    if (uti === 'public.utf8-plain-text') add('text/plain');
  }
  return out;
}

/** The action a source's operation mask asks for: the first of the three
 * react-x11 names it allows. */
export function requestedAction(operations) {
  return (
    ['copy', 'move', 'link'].find((a) => operations?.includes(a)) ?? 'copy'
  );
}

/**
 * Everything on the pasteboard, read now (see the header), as the extras
 * `DropSession.localDrop` hands the handler: `items` by type, the parsed
 * `files`, the best `text`, and a `getData` answering from the same read.
 */
export function readPayload(native, types) {
  const values = {};
  const urls = [];
  const items = (() => {
    try {
      return native.dragItems?.() ?? [];
    } catch {
      return [];
    }
  })();
  items.forEach((item, index) => {
    for (const uti of item?.types ?? []) {
      if (uti === 'public.file-url' || uti === 'public.url') {
        const url = native.dragItemString(index, uti);
        if (url) urls.push(url);
        continue;
      }
      const mime = mimeFromUti(uti, native);
      if (!mime || values[mime] !== undefined) continue;
      const value = isTextual(uti, mime)
        ? native.dragItemString(index, uti)
        : native.dragItemData(index, uti);
      if (value == null) continue;
      values[mime] = value;
      if (
        uti === 'public.utf8-plain-text' &&
        values['text/plain'] === undefined
      ) {
        values['text/plain'] = value;
      }
    }
  });
  if (urls.length) values['text/uri-list'] = urls.join('\r\n') + '\r\n';
  const best = TEXT_TARGETS.find((t) => values[t] !== undefined);
  return {
    items: values,
    files: values['text/uri-list'] ? parseUriList(values['text/uri-list']) : [],
    text: best ? values[best] : undefined,
    getData: (type) =>
      Promise.resolve(values[resolveType(type, types)] ?? null),
  };
}

/** A value as the pasteboard carries it: strings and bytes as they are,
 * anything else as JSON — the same rule the X transport applies. */
const wire = (value) =>
  typeof value === 'string' ||
  Buffer.isBuffer(value) ||
  ArrayBuffer.isView(value) ||
  value instanceof ArrayBuffer
    ? value
    : JSON.stringify(value);

/**
 * A `DragSession`'s payload as `beginDrag`'s spec: one item per file for a
 * `text/uri-list` (that is how the desktop speaks), every other type on the
 * first item under its UTI, thunks as promises the bridge asks `provide`
 * to keep. The files thunk alone resolves now, because the items cannot
 * be counted without it.
 */
export function dragSpec(session, native, scale) {
  const types = session.types;
  const reverse = new Map(); // uti -> react-x11 type
  const items = [];
  const filesType = types.find((t) => TYPE_GROUPS.files.includes(t));
  if (filesType) {
    const list = session._resolve(filesType);
    if (typeof list === 'string') {
      for (const { uri } of parseUriList(list)) {
        items.push({ 'public.file-url': uri });
      }
    }
  }
  const first = {};
  for (const type of types) {
    if (type === filesType) continue;
    const uti = utiFromMime(type, native);
    if (!uti || uti in first) continue;
    reverse.set(uti, type);
    const raw = session._data[type];
    first[uti] = typeof raw === 'function' ? null : wire(raw);
  }
  if (Object.keys(first).length) {
    if (items.length) Object.assign(items[0], first);
    else items.push(first);
  }
  if (!items.length) items.push({ 'public.utf8-plain-text': '' });
  return {
    x: session.press.x / scale,
    y: session.press.y / scale,
    items,
    operations: session.actions,
    provide: (uti) => wire(session._resolve(reverse.get(uti) ?? uti)),
  };
}

/**
 * One window's drop side: the registered types, and the four events turned
 * into `DropSession` calls with the answer sent back inside the callback.
 */
export class CocoaDropTransport {
  constructor(wnd, session, node) {
    this.wnd = wnd;
    this.session = session;
    this.node = node;
    this._registered = null;
    // AppKit tracks the whole drag on this thread: the pump does not return
    // until the drop, so nothing an enter/over dispatch schedules — a
    // `useDropTarget` lighting its "drop here" label, any handler's
    // `setState` — has a frame tick or a microtask to land on. Discrete is
    // the one lane the app can land by hand from inside the callback
    // (src/cocoa/app.js `_afterInput`), which is where the answer to
    // AppKit's question is painted. The renderer's own `:drag-over` needs
    // none of this and never did.
    session.hoverPriority = DiscreteEventPriority;
    this.refreshTypes();
  }

  /** The base set plus every concrete type a `dropAccept` under this
   * window names, re-registered only when the list changes. */
  refreshTypes() {
    const native = this.wnd._native;
    const types = new Set(BASE_DROP_UTIS);
    for (const mime of this.node._dndConcreteTypes?.() ?? []) {
      const uti = utiFromMime(mime, native);
      if (uti) types.add(uti);
    }
    const list = [...types];
    if (this._registered && list.join('\n') === this._registered.join('\n')) {
      return;
    }
    this._registered = list;
    this.wnd.registerDropTypes(list);
  }

  handle(ev) {
    switch (ev.type) {
      case 'drag-enter':
      case 'drag-over':
        return this._over(ev);
      case 'drag-exit':
        return this._leave(ev);
      case 'drag-perform':
        return this._perform(ev);
      default:
        return undefined;
    }
  }

  /** The live drag in this process, when the pasteboard is ours. */
  _local(ev) {
    return ev.local ? (this.wnd.app._activeDrag ?? null) : null;
  }

  _offer(ev) {
    const drag = this._local(ev);
    if (drag) return drag._offer();
    return {
      types: offeredTypes(ev.types, this.wnd._native),
      action: requestedAction(ev.operations),
      source: 'external',
    };
  }

  _point(ev) {
    const s = this.wnd.scale;
    return { rootX: Math.round(ev.gx * s), rootY: Math.round(ev.gy * s) };
  }

  _over(ev) {
    const drag = this._local(ev);
    const offer = this._offer(ev);
    const { rootX, rootY } = this._point(ev);
    const answer = this.session.localOver(rootX, rootY, offer, Date.now());
    if (drag) {
      drag.accepted = answer.accepted;
      if (answer.accepted) drag.currentAction = answer.action;
    }
    const response = { accept: answer.accepted };
    if (answer.accepted && ev.operations?.includes(answer.action)) {
      response.operation = answer.action;
    }
    this.wnd.setDropResponse(response);
  }

  _leave(ev) {
    const drag = this._local(ev);
    // the leaving half of the same stream, in the same lane as the enter
    runWithPriority(DiscreteEventPriority, () => this.session.localLeave());
    if (drag) drag.accepted = false;
  }

  _perform(ev) {
    const drag = this._local(ev);
    const offer = this._offer(ev);
    const extras = drag
      ? drag._dropExtras()
      : readPayload(this.wnd._native, offer.types);
    const outcome = this.session.localDrop(offer, extras, Date.now());
    if (drag && outcome.handled) drag.currentAction = outcome.action;
    const response = { accept: outcome.handled };
    if (outcome.handled && ev.operations?.includes(outcome.action)) {
      response.operation = outcome.action;
    }
    this.wnd.setDropResponse(response);
  }
}

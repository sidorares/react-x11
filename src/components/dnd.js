// useDropTarget — the convenience layer over the drop-target host props
// (`dropAccept`, `onDragEnter/Leave/Over`, `onDrop`; see src/dnd.js), the
// same two-layer shape as anchorRect/useAnchor. The hook adds what a
// component wants and the host props deliberately do not: render state.
// The common "highlight the dropzone" case needs neither — a
// `':drag-over'` style block does it with no state at all — so reach for
// this only when the render itself changes (an "isOver" hint label,
// disabling other controls mid-drag).

import { useState } from 'react';
import { matchAccept } from '../dnd.js';

/**
 * const { dropProps, isOver, isAccepted } = useDropTarget({
 *   accept: ['files'],
 *   onDrop: (e) => setFiles(e.files),
 * });
 * return <box {...dropProps} style={s.zone} />;
 *
 * `accept` here maps to the `dropAccept` host prop — inside a hook named
 * useDropTarget the shorter word is unambiguous, and it is the name
 * react-dropzone users expect. `onDrop`'s return value is passed through,
 * so an async handler keeps holding XdndFinished (up to the watchdog).
 */
export function useDropTarget(options = {}) {
  const { accept, onDrop, onDragOver, onDragEnter, onDragLeave } = options;
  // null: no drag over this node; otherwise whether the offer matches
  const [drag, setDrag] = useState(null);
  const dropProps = {
    dropAccept: accept,
    onDragEnter: (ev) => {
      setDrag({ accepted: matchAccept(accept ?? null, ev.types) });
      onDragEnter?.(ev);
    },
    onDragLeave: (ev) => {
      setDrag(null);
      onDragLeave?.(ev);
    },
    onDragOver,
    onDrop: (ev) => {
      setDrag(null);
      return onDrop?.(ev);
    },
  };
  return {
    dropProps,
    isOver: drag != null,
    isAccepted: Boolean(drag?.accepted),
  };
}

/**
 * useDragSource — the source-side twin. Spread `dragProps` on the node to
 * drag; the hook adds render state (`isDragging`, the pointer `position` in
 * screen coordinates) so a component can dim itself, show a hint, or render
 * a drag preview. The preview is deliberately userland — a `<popup
 * dragPreview>` following `position` is a live React tree, which is more
 * than a DOM `setDragImage` bitmap ever was; the `dragPreview` prop is what
 * keeps the router from seeing the popup as the window under the pointer.
 *
 *   const { dragProps, isDragging, position } = useDragSource({
 *     data: {
 *       'text/uri-list': () => toUriList(item),   // thunk: resolved lazily
 *       'application/x-myapp-item': item,         // live for in-app drops
 *     },
 *     actions: ['copy', 'move'],
 *     onDragEnd: (e) => { if (e.action === 'move') remove(item.id); },
 *   });
 *   return (
 *     <>
 *       <box {...dragProps} style={{ ':dragging': { backgroundColor: '$dim' } }} />
 *       {isDragging && (
 *         <popup dragPreview x={position.x + 12} y={position.y + 12}>
 *           <Chip label={item.name} />
 *         </popup>
 *       )}
 *     </>
 *   );
 */
export function useDragSource(options = {}) {
  const { data, actions, onDragStart, onDrag, onDragEnd } = options;
  const [drag, setDrag] = useState(null);
  const dragProps = {
    draggable: true,
    dragData: data,
    dragActions: actions,
    onDragStart: (ev) => {
      onDragStart?.(ev);
      if (!ev.defaultPrevented) {
        setDrag({ x: ev.screenX, y: ev.screenY, accepted: false });
      }
    },
    onDrag: (ev) => {
      setDrag({ x: ev.screenX, y: ev.screenY, accepted: ev.accepted });
      onDrag?.(ev);
    },
    onDragEnd: (ev) => {
      setDrag(null);
      onDragEnd?.(ev);
    },
  };
  return { dragProps, isDragging: drag != null, position: drag };
}

// The drag-and-drop style states must be writable from TypeScript: the
// documented highlight in docs/drag-and-drop.md is a `:drag-over` block,
// and it did not typecheck until they were declared.
import { createStyles } from '../../src/index.js';

export const s = createStyles({
  zone: {
    borderColor: '#888888',
    ':drag-over': { borderColor: '#00aa00', backgroundColor: '#eeffee' },
  },
  card: {
    backgroundColor: '#ffffff',
    ':dragging': { backgroundColor: '#eeeeee' },
  },
});

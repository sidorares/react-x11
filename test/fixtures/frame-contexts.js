// The shared-module half of a frame context: the app imports this to
// provide, the pane imports it to read, and the import is what registers
// the key on both sides — identity by construction (src/frame/env.js).
import { createFrameContext } from '../../src/frame/env.js';

export const Session = createFrameContext('test:session', { user: null });

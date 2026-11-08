// The media capture lab in a `<Frame>` pane, which is what
// `npm run labs:media-capture -- --pane` shows: the same sections, in a
// process with no AppKit of its own, their capture done by the host
// (docs/frame.md). The pane has no window to capture or keep out of a
// capture, so those rows are not here.
import React from 'react';

import { Lab } from './media-capture.jsx';

export default function MediaCapturePane() {
  return <Lab />;
}

// The Windows taskbar's own surfaces — and, more to the point, what an app
// that also runs on macOS and X11 does about them.
//
//   npm run examples:taskbar
//
// Three things the taskbar has that no other desktop does: a toolbar under the
// hover preview, a Tasks category in the jump list, and the shell's Recent
// list. None of them is a rung on a portable ladder, and this example does not
// pretend otherwise — it asks the **launcher capability** whether this desktop
// has each one and says so on screen.
//
// They sit there, beside `badge` and `progress`, because all of them hang off
// the single icon the desktop shows for this app; `backend` names which
// launcher answered (`taskbar` here, `cocoa` for a Dock, `launcherentry` on
// Linux) and is for the footer and bug reports, never for a branch.
//
// **The thing to copy is the shape, not the feature.** The hooks are called
// unconditionally and do nothing where the backend has none, so there is no
// `process.platform` anywhere and the same tree runs everywhere. On macOS and
// X11 this window opens, reports three `false`s, and is otherwise a normal
// app. That is the whole seam: a backend installs a method, and its presence
// *is* the capability (docs/windows-integrations.md).
import React, { useState } from 'react';

import {
  createRoot,
  useDesktopCapability,
  useJumpList,
  useRecentDocument,
  useThumbnailToolbar,
} from '../src/index.js';

/** A 16×16 white glyph on transparent, which is what a toolbar icon is: the
 *  shell tints it for the theme, so the shape is the whole of it. */
function glyph(draw) {
  const data = new Uint8Array(16 * 16 * 4);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const at = (y * 16 + x) * 4;
      data[at] = 255;
      data[at + 1] = 255;
      data[at + 2] = 255;
      data[at + 3] = draw(x, y) ? 255 : 0;
    }
  }
  return { data, width: 16, height: 16 };
}

const ICONS = {
  prev: glyph((x, y) => x >= 4 && x <= 11 && Math.abs(y - 8) <= x - 3),
  play: glyph((x, y) => x >= 5 && x <= 11 && Math.abs(y - 8) <= 11 - x),
  pause: glyph(
    (x, y) => x >= 4 && x <= 11 && y >= 3 && y <= 12 && (x <= 6 || x >= 9),
  ),
  next: glyph((x, y) => x >= 4 && x <= 11 && Math.abs(y - 8) <= 12 - x),
};

const TRACKS = ['Kind of Blue', 'A Love Supreme', 'Blue Train'];

function Player() {
  const [track, setTrack] = useState(0);
  const [playing, setPlaying] = useState(false);

  // One probe, three answers. `settled` is true on the first frame wherever
  // the answer needed nothing asked, which is every backend that has these.
  const launcher = useDesktopCapability('launcher');
  const canToolbar = Boolean(launcher.features.thumbnailToolbar);
  const canJumpList = Boolean(launcher.features.tasks);
  const canRecent = Boolean(launcher.features.recentDocuments);

  // Called every render, whatever the backend. `null` where there is no
  // toolbar keeps the intent visible rather than hiding the call in a branch.
  useThumbnailToolbar(
    canToolbar
      ? [
          {
            id: 'prev',
            tooltip: 'Previous',
            icon: ICONS.prev,
            enabled: track > 0,
          },
          {
            id: 'play',
            tooltip: playing ? 'Pause' : 'Play',
            icon: playing ? ICONS.pause : ICONS.play,
          },
          {
            id: 'next',
            tooltip: 'Next',
            icon: ICONS.next,
            enabled: track < TRACKS.length - 1,
          },
        ]
      : null,
    (id) => {
      if (id === 'play') setPlaying((was) => !was);
      if (id === 'prev') setTrack((at) => Math.max(0, at - 1));
      if (id === 'next') setTrack((at) => Math.min(TRACKS.length - 1, at + 1));
    },
  );

  // A jump-list task starts a *new* process with these arguments — the shell
  // does not call back into this one — so a task is for something the app can
  // do from a cold start.
  useJumpList(
    canJumpList ? [{ title: 'New window', arguments: '--new' }] : null,
  );

  useRecentDocument(canRecent ? `C:/Music/${TRACKS[track]}.flac` : null);

  const label = (name, yes) =>
    `${name}: ${yes ? 'yes' : 'no — this desktop has none'}`;

  return (
    <window title="Taskbar surfaces" width={560} height={300}>
      <box
        style={{
          flexGrow: 1,
          padding: 24,
          gap: 14,
          backgroundColor: '$background',
        }}
      >
        <text style={{ fontSize: 20, color: '$text' }}>{TRACKS[track]}</text>
        <text style={{ fontSize: 13, color: '$textMuted' }}>
          {playing ? 'Playing' : 'Paused'}
          {canToolbar
            ? ' — hover this window\u2019s taskbar button and use the toolbar under it'
            : ''}
        </text>
        <box style={{ gap: 4, marginTop: 8 }}>
          <text style={{ fontSize: 12, color: '$textMuted' }}>
            {label('thumbnail toolbar', canToolbar)}
          </text>
          <text style={{ fontSize: 12, color: '$textMuted' }}>
            {label('jump list', canJumpList)}
          </text>
          <text style={{ fontSize: 12, color: '$textMuted' }}>
            {label('recent documents', canRecent)}
          </text>
          <text style={{ fontSize: 11, color: '$textMuted', marginTop: 6 }}>
            {`launcher: ${launcher.backend ?? 'none'}`}
          </text>
        </box>
      </box>
    </window>
  );
}

createRoot().then((root) => root.render(<Player />));

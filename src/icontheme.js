// The freedesktop icon theme: an icon found by name the way the Icon Theme
// Specification finds it, for a symbol drawn inside a window on Linux (#591).
//
// A theme is a directory of the same name under any of the base directories
// — `~/.icons`, `$XDG_DATA_HOME/icons`, each `$XDG_DATA_DIRS/icons` — with an
// `index.theme` saying which of its subdirectories hold which sizes and which
// themes it inherits from. A lookup tries the user's theme, then everything
// it inherits, then `hicolor`, the theme every other one falls back on, and
// last the loose files in `/usr/share/pixmaps`. Inside a theme it takes the
// first directory whose size matches, and failing that the closest one.
//
// The directories are listed rather than probed file by file: one `readdir`
// per directory, once, answers every name looked up there afterwards, where
// a `stat` per name per directory per theme is thousands of calls for a
// toolbar. Both run synchronously, since a layout pass cannot wait — the
// first lookup in a theme pays for the listing, and later ones are a `Map`.

import * as nodeFs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The formats a lookup answers with, in the specification's order. XPM is
 *  left out: nothing here decodes it. */
const EXTENSIONS = ['png', 'svg'];

/** Every base directory the specification searches, in its order. */
export function iconBaseDirs(env = process.env, home = homedir()) {
  const dataHome = env.XDG_DATA_HOME || join(home, '.local', 'share');
  const dataDirs = (env.XDG_DATA_DIRS || '/usr/local/share:/usr/share')
    .split(':')
    .filter(Boolean);
  return [
    join(home, '.icons'),
    join(dataHome, 'icons'),
    ...dataDirs.map((dir) => join(dir, 'icons')),
  ];
}

/** Where loose icons with no theme live, searched last. */
export const PIXMAP_DIRS = ['/usr/share/pixmaps'];

/**
 * `index.theme`'s keys, section by section — the desktop-entry format, which
 * is an INI file with `#` comments. Values stay strings.
 */
export function parseIndexTheme(text) {
  const sections = new Map();
  let current = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      current = new Map();
      sections.set(header[1], current);
      continue;
    }
    const eq = line.indexOf('=');
    if (current && eq > 0) {
      current.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
    }
  }
  return sections;
}

const list = (value) =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const int = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};

/** One subdirectory's size rules, with the specification's defaults. */
function directoryRules(keys) {
  const size = int(keys?.get('Size'), 0);
  return {
    size,
    scale: int(keys?.get('Scale'), 1),
    type: keys?.get('Type') ?? 'Threshold',
    minSize: int(keys?.get('MinSize'), size),
    maxSize: int(keys?.get('MaxSize'), size),
    threshold: int(keys?.get('Threshold'), 2),
  };
}

/** The specification's DirectoryMatchesSize. */
function matchesSize(dir, size, scale) {
  if (dir.scale !== scale) return false;
  if (dir.type === 'Fixed') return dir.size === size;
  if (dir.type === 'Scalable')
    return dir.minSize <= size && size <= dir.maxSize;
  return dir.size - dir.threshold <= size && size <= dir.size + dir.threshold;
}

/** The specification's DirectorySizeDistance, with its Threshold branch's
 *  typos read as what they mean: the threshold's bounds, times the scale. */
function sizeDistance(dir, size, scale) {
  const want = size * scale;
  if (dir.type === 'Fixed') return Math.abs(dir.size * dir.scale - want);
  const low = dir.type === 'Scalable' ? dir.minSize : dir.size - dir.threshold;
  const high = dir.type === 'Scalable' ? dir.maxSize : dir.size + dir.threshold;
  if (want < low * dir.scale) return low * dir.scale - want;
  if (want > high * dir.scale) return want - high * dir.scale;
  return 0;
}

/**
 * Icon lookup in one theme and everything under it. `find(name, size,
 * scale)` answers an absolute path, or null.
 */
export class IconTheme {
  constructor({
    theme = 'hicolor',
    baseDirs = iconBaseDirs(),
    pixmapDirs = PIXMAP_DIRS,
    fs = nodeFs,
  } = {}) {
    this.theme = theme;
    this.baseDirs = baseDirs;
    this.pixmapDirs = pixmapDirs;
    this.fs = fs;
    this._themes = new Map(); // name -> { dirs, inherits } | null
    this._listings = new Map(); // absolute dir -> Set of file names | null
    this._found = new Map(); // name|size|scale -> path | null
  }

  find(name, size, scale = 1) {
    const key = `${name}\u0000${size}\u0000${scale}`;
    if (this._found.has(key)) return this._found.get(key);
    const path =
      this._inTheme(name, size, scale, this.theme, new Set()) ??
      (this.theme === 'hicolor'
        ? null
        : this._inTheme(name, size, scale, 'hicolor', new Set())) ??
      this._loose(name);
    this._found.set(key, path);
    return path;
  }

  /** FindIconHelper: this theme, then the ones it inherits, depth first. */
  _inTheme(name, size, scale, theme, seen) {
    if (seen.has(theme)) return null;
    seen.add(theme);
    const index = this._index(theme);
    if (!index) return null;
    const found = this._lookup(name, size, scale, theme, index);
    if (found) return found;
    for (const parent of index.inherits) {
      const inherited = this._inTheme(name, size, scale, parent, seen);
      if (inherited) return inherited;
    }
    return null;
  }

  /** LookupIcon: a directory of the right size, else the closest one. */
  _lookup(name, size, scale, theme, index) {
    let closest = null;
    let distance = Infinity;
    for (const dir of index.dirs) {
      const fits = matchesSize(dir.rules, size, scale);
      const d = fits ? 0 : sizeDistance(dir.rules, size, scale);
      if (!fits && d >= distance) continue;
      for (const base of this.baseDirs) {
        const at = join(base, theme, dir.path);
        const file = this._fileIn(at, name);
        if (!file) continue;
        if (fits) return file;
        closest = file;
        distance = d;
        break;
      }
    }
    return closest;
  }

  /** The loose files: an icon with no theme at all. */
  _loose(name) {
    for (const dir of this.pixmapDirs) {
      const file = this._fileIn(dir, name);
      if (file) return file;
    }
    return null;
  }

  _fileIn(dir, name) {
    const names = this._listing(dir);
    if (!names) return null;
    for (const ext of EXTENSIONS) {
      const file = `${name}.${ext}`;
      if (names.has(file)) return join(dir, file);
    }
    return null;
  }

  _listing(dir) {
    if (this._listings.has(dir)) return this._listings.get(dir);
    let names = null;
    try {
      names = new Set(this.fs.readdirSync(dir));
    } catch {
      // not there, which is most directories in most base directories
    }
    this._listings.set(dir, names);
    return names;
  }

  /** A theme's `index.theme`, from the first base directory that has one. */
  _index(theme) {
    if (this._themes.has(theme)) return this._themes.get(theme);
    let index = null;
    for (const base of this.baseDirs) {
      let text;
      try {
        text = this.fs.readFileSync(join(base, theme, 'index.theme'), 'utf8');
      } catch {
        continue;
      }
      const sections = parseIndexTheme(text);
      const head = sections.get('Icon Theme');
      const names = [
        ...list(head?.get('Directories')),
        ...list(head?.get('ScaledDirectories')),
      ];
      index = {
        inherits: list(head?.get('Inherits')),
        dirs: [...new Set(names)].map((path) => ({
          path,
          rules: directoryRules(sections.get(path)),
        })),
      };
      break;
    }
    this._themes.set(theme, index);
    return index;
  }
}

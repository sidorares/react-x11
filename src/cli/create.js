// `react-x11 create <dir>` — a new app, ready for `npm run dev`. Also what
// `npm create react-x11 <dir>` runs: create-react-x11 (./create-react-x11/,
// published beside react-x11 at the same version) is one import of
// `runCreate`, so the two commands cannot drift apart.
//
// The app it writes is the shortest one that shows the whole loop: a
// component in its own module (which is what `react-x11 dev` hot-reloads), an
// entry that mounts it for a plain run, and the hot-reload toolchain already
// in devDependencies, so the first `npm run dev` does not stop to ask for it.
// Every version comes from this copy of react-x11's own manifest, which is
// what keeps a generated app on the majors the loader is written against.
//
// Beside the code it writes the two files a coding agent reads first:
// AGENTS.md (react-x11 is not react-dom, the rules that throw, where the
// installed docs are, how to look at what it built) and DESIGN.md (the app's
// design brief, and the desktop conventions in react-x11's terms), plus a
// CLAUDE.md that imports AGENTS.md for Claude Code, which reads only its own
// name. Their text is ./templates/*.template.md — named so that no agent
// working on this repo takes them for instructions of its own.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OWN_PACKAGE = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../package.json', import.meta.url)),
    'utf8',
  ),
);

/** A mistake the developer can fix from the message: printed bare. */
export class CreateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CreateError';
  }
}

const usage = (
  command,
) => `Usage: ${command} <dir> [--no-install] [--no-agents-md]

Writes a new react-x11 app into <dir> and installs its dependencies.

Options:
  --no-install     Write the files only.
  --no-agents-md   Leave out AGENTS.md and CLAUDE.md, what coding agents
                   read. DESIGN.md, the app's design brief, is still written.
  -h, --help       Show this help.
`;

const FLAGS = new Set(['--no-install', '--no-agents-md']);

/** A template from ./templates, with its `{{name}}`s filled in. */
function template(file, values) {
  const text = readFileSync(
    fileURLToPath(new URL(`./templates/${file}`, import.meta.url)),
    'utf8',
  );
  return text.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (!(key in values)) throw new Error(`${file}: no value for ${match}`);
    return values[key];
  });
}

// Files a fresh checkout or an editor leaves behind, which do not make a
// directory anyone's project yet.
const IGNORABLE = new Set(['.git', '.DS_Store', '.idea', '.vscode']);

/**
 * The package manager that launched this command: `npm create` and `npx`,
 * `pnpm create`, `yarn create` and `bun create` all set
 * `npm_config_user_agent`. The new directory has no lockfile to ask, and a
 * parent's is someone else's project.
 */
export function packageManagerOf(
  userAgent = process.env.npm_config_user_agent,
) {
  return /^(npm|pnpm|yarn|bun)\//.exec(userAgent ?? '')?.[1] ?? 'npm';
}

/** `name` as an npm package name, or null when nothing of it survives. */
export function packageNameFor(name) {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9._~-]+/g, '-')
    .replace(/^[._-]+|-+$/g, '');
  return cleaned === '' ? null : cleaned.slice(0, 214);
}

/** The new app's files, as a map from path to contents. */
export function appFiles({
  name,
  title = name,
  manager = 'npm',
  agentsMd = true,
}) {
  const { version, peerDependencies, devDependencies } = OWN_PACKAGE;
  const run = manager === 'npm' ? 'npm run' : manager;
  const pkg = {
    name,
    version: '0.1.0',
    private: true,
    type: 'module',
    scripts: {
      dev: 'react-x11 dev src/App.jsx',
      start: 'tsx src/main.jsx',
    },
    dependencies: {
      react: peerDependencies.react,
      'react-x11': `^${version}`,
    },
    devDependencies: {
      '@babel/core': peerDependencies['@babel/core'],
      '@babel/plugin-transform-react-jsx':
        peerDependencies['@babel/plugin-transform-react-jsx'],
      'hot-module-replacement': peerDependencies['hot-module-replacement'],
      'react-refresh': peerDependencies['react-refresh'],
      tsx: devDependencies.tsx,
    },
  };
  const filled = { version, run };
  const agentFiles = agentsMd
    ? {
        'AGENTS.md': template('AGENTS.template.md', filled),
        'CLAUDE.md': '@AGENTS.md\n',
      }
    : {};
  return {
    'package.json': `${JSON.stringify(pkg, null, 2)}\n`,
    '.gitignore': 'node_modules\n',
    'src/App.jsx': `import React from 'react';

export default function App() {
  const [count, setCount] = React.useState(0);
  return (
    <window title=${JSON.stringify(title)} style={{ padding: 24, gap: 12 }}>
      <text style={{ fontSize: 22 }}>Hello from react-x11</text>
      <text>Edit src/App.jsx and save: the window updates in place.</text>
      <box
        onClick={() => setCount((n) => n + 1)}
        style={{
          alignSelf: 'flex-start',
          padding: '6px 14px',
          borderRadius: 6,
          backgroundColor: '$accent',
          color: '$accentText',
          cursor: 'pointer',
          ':hover': { backgroundColor: '$accentHover' },
          ':active': { backgroundColor: '$accentActive' },
        }}
      >
        <text>Clicked {count} times</text>
      </box>
    </window>
  );
}
`,
    'src/main.jsx': `// The entry for a plain run (${run} start). \`${run} dev\` mounts App itself.
import React from 'react';
import { createRoot } from 'react-x11';
import App from './App.jsx';

const root = await createRoot();
root.render(<App />);
`,
    'README.md': `# ${title}

A [react-x11](https://sidorares.github.io/react-x11/) app.

- \`${run} dev\` — run it with hot reload: save \`src/App.jsx\` and the window
  updates in place, state and all.
- \`${run} start\` — run it without.

[DESIGN.md](DESIGN.md) is the app's design brief: fill in its first section.${
      agentsMd
        ? `
Coding agents read [AGENTS.md](AGENTS.md) first: how react-x11 differs from
react-dom, and where the docs that came with it are.`
        : ''
    }
`,
    'DESIGN.md': template('DESIGN.template.md', filled),
    ...agentFiles,
  };
}

function installCommand(manager) {
  return manager === 'yarn' ? ['yarn'] : [manager, 'install'];
}

/**
 * Write a new app into `dir` and, unless `install` is false, install it.
 * Returns the directory. `log` and `run` are the seams the tests replace.
 */
export function createApp(dir, options = {}) {
  const {
    install = true,
    agentsMd = true,
    manager = packageManagerOf(),
    log = (line) => console.log(line),
    run = (argv, cwd) =>
      spawnSync(argv[0], argv.slice(1), {
        cwd,
        stdio: 'inherit',
        // npm and friends are .cmd scripts there, which only a shell runs
        shell: process.platform === 'win32',
      }).status,
  } = options;

  const target = resolve(dir);
  const title = basename(target);
  const name = packageNameFor(title);
  if (name === null) {
    throw new CreateError(
      `${dir}: no package name can be made from "${title}". Name the ` +
        'directory with a letter or a digit in it.',
    );
  }
  if (existsSync(target)) {
    const present = readdirSync(target).filter((f) => !IGNORABLE.has(f));
    if (present.length > 0) {
      throw new CreateError(
        `${dir} is not empty (${present.slice(0, 3).join(', ')}` +
          `${present.length > 3 ? ', …' : ''}). Pick a new directory, or ` +
          'empty this one.',
      );
    }
  }

  for (const [file, contents] of Object.entries(
    appFiles({ name, title, manager, agentsMd }),
  )) {
    const path = join(target, file);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, contents);
  }
  const shown = relative(process.cwd(), target) || '.';
  log(`Created ${title} in ${target}`);

  if (install) {
    const argv = installCommand(manager);
    log(`\nInstalling dependencies with ${manager}…`);
    const status = run(argv, target);
    if (status !== 0) {
      throw new CreateError(
        `\`${argv.join(' ')}\` failed${status == null ? '' : ` (exit ${status})`}; ` +
          `its output is above. The files are written: run it again in ${shown}.`,
      );
    }
  }

  const runScript = manager === 'npm' ? 'npm run' : manager;
  const steps = [
    shown === '.' ? null : `cd ${shown}`,
    install ? null : installCommand(manager).join(' '),
    `${runScript} dev`,
  ].filter(Boolean);
  log(`\nNext:\n\n${steps.map((s) => `  ${s}`).join('\n')}\n`);
  return target;
}

/**
 * The command line: `react-x11 create …` hands over what follows `create`,
 * and create-react-x11 everything after its own name, so `command` is only
 * what the messages call it. An exit code.
 */
export function runCreate(
  argv,
  { command = 'react-x11 create', ...options } = {},
) {
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(usage(command));
    return 0;
  }
  const flags = argv.filter((arg) => arg.startsWith('-'));
  const unknown = flags.find((flag) => !FLAGS.has(flag));
  if (unknown !== undefined) {
    process.stderr.write(
      `${command}: no option ${unknown}.\n\n${usage(command)}`,
    );
    return 2;
  }
  const dirs = argv.filter((arg) => !arg.startsWith('-'));
  if (dirs.length !== 1) {
    process.stderr.write(
      `${command}: ${dirs.length === 0 ? 'which directory?' : 'one directory at a time.'}\n\n${usage(command)}`,
    );
    return 2;
  }
  try {
    createApp(dirs[0], {
      install: !flags.includes('--no-install'),
      agentsMd: !flags.includes('--no-agents-md'),
      ...options,
    });
    return 0;
  } catch (err) {
    if (!(err instanceof CreateError)) throw err;
    process.stderr.write(`${command}: ${err.message}\n`);
    return 1;
  }
}

/** A mistake the developer can fix from the message. */
export class CreateError extends Error {}

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export interface CreateOptions {
  /** Install the dependencies after writing the files. Default `true`. */
  install?: boolean;
  /** Write AGENTS.md and CLAUDE.md, for coding agents. Default `true`. */
  agentsMd?: boolean;
  /** Who installs them. Default: whichever launched the command. */
  manager?: PackageManager;
  /** Where progress goes. Default `console.log`. */
  log?: (line: string) => void;
  /** Runs the install; returns its exit status. */
  run?: (argv: string[], cwd: string) => number | null;
}

/** Write a new app into `dir`; resolves to its absolute path. */
export function createApp(dir: string, options?: CreateOptions): string;

/**
 * `react-x11 create`'s command line, given the arguments after `create`.
 * `command` is only what its messages call it. Returns an exit code.
 */
export function runCreate(
  argv: string[],
  options?: CreateOptions & { command?: string },
): number;

/** The package manager that launched this process, from its user agent. */
export function packageManagerOf(userAgent?: string): PackageManager;

/** `name` as an npm package name, or null when nothing of it survives. */
export function packageNameFor(name: string): string | null;

/** The new app's files, as a map from path to contents. */
export function appFiles(options: {
  name: string;
  title?: string;
  manager?: PackageManager;
  agentsMd?: boolean;
}): Record<string, string>;

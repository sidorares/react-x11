// A snippet of ESM run in a child process, from the repo root.
//
// The suites that need this are the ones asking what react-x11 does *before*
// anything has touched it: what an import costs, what a cold `createRoot()`
// spawns, what a process-wide latch does on a process that has only ever seen
// one root. None of those questions survive being asked inside a test runner
// that has already imported half the library and set NO_AT_BRIDGE on the way.
//
// The environment is inherited, so a caller that cares about a variable the
// harness sets must clear it explicitly — `{ NO_AT_BRIDGE: '' }`.

import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * @param {string[]} args node's own argv
 * @param {Record<string, string>} [env] added to this process's environment
 * @returns {Promise<{ code: number, error?: Error, stdout: string, stderr: string }>}
 */
export function runNode(args, env = {}, timeout = 20000) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      args,
      { cwd: repo, env: { ...process.env, ...env }, timeout },
      (error, stdout, stderr) =>
        resolve({ code: error?.code ?? 0, error, stdout, stderr }),
    );
    child.on('error', () => {});
  });
}

/** @param {string} source top-level `await` is available. */
export function runScript(source, env = {}, nodeArgs = [], timeout) {
  return runNode(
    [...nodeArgs, '--input-type=module', '--eval', source],
    env,
    timeout,
  );
}

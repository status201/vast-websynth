// What the repo's command-line scripts share: argument flags (the benches, the
// README screenshots), and how the two hooks (`sdd-guard.mjs`, `spec-lint.mjs`)
// shell out to git and read the JSON Claude Code hands them on stdin.

import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);

/** The value after `--name`, or `def` when the flag is absent or has no value. */
export const flag = (name, def = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};

/** Every value of a repeatable `--name`, in order. */
export const flags = (name) => argv.reduce((acc, a, i) => (a === `--${name}` ? [...acc, argv[i + 1]] : acc), []);

/** Run git and return its trimmed stdout — or '' on any failure, so a hook fails open. */
export function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/** All of stdin as one UTF-8 string. */
export async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

/** JSON.parse, or `{}` for anything that is not JSON. */
export function parseJson(json) {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

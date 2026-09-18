/**
 * The one reading of a path glob in the spec tooling.
 *
 * `# pinned by:` and `source:` entries may be globs, and both `spec-lint.mjs` (to
 * check they match something) and `req-migrate.mjs` (to work out which spec claims
 * a file) have to agree on what one means. Two implementations would be two
 * answers to "does this spec own this file?", which is the question a rename hangs
 * on. Zero-dep, like everything CI runs without `npm install`.
 *
 * `*` stops at a path separator, `**` crosses them, `?` is one non-separator
 * character, and everything else is literal.
 */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; } else { re += '[^/]*'; }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

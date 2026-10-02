/**
 * The one reading of a path glob in the spec tooling.
 *
 * `# pinned by:` and `source:` entries may be globs, and `spec-lint.mjs` checks
 * that each one matches something. (The ADR-021 id migration read them through this
 * module too, which is why it is its own file.) Zero-dep, like everything CI runs
 * without `npm install`.
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

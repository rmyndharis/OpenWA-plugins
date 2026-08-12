import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, posix } from 'node:path';

// `configUi.entry` comes from a manifest, and the packager archives whatever it names — a directory
// entry pulls in everything beneath it, recursively. Two things therefore have to hold: the entry must
// stay inside the plugin directory, and the top-level name handed to the packager must come from the
// NORMALISED path. Spelling it './config/index.html' is perfectly valid and names a real file, but its
// literal first segment is '.', which would archive the entire plugin directory.
//
// Normalise first, judge second: a build should not break over punctuation, and the two ways an entry
// can be wrong — escaping the directory, or naming the directory itself — get different messages,
// because they need different fixes.
export function configUiMember(entry) {
  const rel = posix.normalize(String(entry).split('\\').join('/'));
  const segments = rel.split('/').filter((s) => s !== '');

  // Backslashes are folded above so a Windows-style '..\secrets' cannot pass as a single segment on a
  // POSIX runner; testing the folded path for absoluteness also catches a UNC '\\server\share', which
  // POSIX isAbsolute() reads as relative.
  if (isAbsolute(entry) || posix.isAbsolute(rel) || segments[0] === '..') {
    throw new Error(`configUi.entry "${entry}" must stay inside the plugin directory`);
  }
  if (segments.length === 0 || segments[0] === '.') {
    throw new Error(`configUi.entry "${entry}" names the plugin directory itself — point it at the entry file`);
  }
  return segments[0];
}

// Resolve an entry to the archive members it contributes, as forward-slash relative paths.
//
// lstat, not stat: stat follows links, and a directory link inside a plugin pulls whatever it points
// at into the archive — a `ui` link to a sibling directory put that directory's files into the zip,
// contents and all, while the build reported success. Refusing links outright rather than resolving
// and re-checking them is both simpler and more correct here: the archive stores file CONTENTS, so a
// link would be flattened into a copy anyway, and an absolute one points at a path that exists only
// on the machine that built it.
export function collectEntryFiles(base, rel) {
  const abs = join(base, rel);
  const stat = lstatSync(abs);
  if (stat.isSymbolicLink()) {
    throw new Error(`"${rel}" is a symlink — an archive member must be a real file inside the plugin`);
  }
  if (stat.isDirectory()) {
    return readdirSync(abs, { withFileTypes: true }).flatMap((e) => collectEntryFiles(base, `${rel}/${e.name}`));
  }
  return [{ name: rel, data: readFileSync(abs) }];
}

// Collect every entry into one member list, keyed by archive path so overlapping entries contribute
// each file once. They do overlap: configUiMember returns the TOP-LEVEL name, so a configUi entry of
// 'dist/ui.html' adds 'dist' to a list that already names 'dist/index.js' and 'dist/package.json'.
// A member's name determines its content, so collapsing by name cannot lose anything.
export function collectMembers(base, entries) {
  const byName = new Map();
  for (const entry of entries) {
    for (const file of collectEntryFiles(base, entry)) byName.set(file.name, file);
  }
  return [...byName.values()];
}

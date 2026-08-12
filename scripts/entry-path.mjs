import { isAbsolute, posix } from 'node:path';

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

import { isAbsolute } from 'node:path';

// `configUi.entry` comes from a manifest, and the packager archives whatever it names — a directory
// entry pulls in everything beneath it, recursively. An entry that climbs out of the plugin directory
// therefore archives the repo itself (node_modules included), and the size limit that would catch it
// only runs after the zip is already on disk. Refuse anything but a plain relative path, and return
// the top-level name to add to the archive.
export function configUiMember(entry) {
  const segments = entry.split('/');
  if (isAbsolute(entry) || segments.includes('..') || segments.includes('')) {
    throw new Error(`configUi.entry "${entry}" must be a relative path inside the plugin directory`);
  }
  return segments[0];
}

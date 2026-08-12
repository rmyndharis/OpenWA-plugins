// Loader contract for built bundles. Nothing else in this repo loads one: package.mjs asserts that
// `main` is a MEMBER of the archive, not that the file can be required or that it exports what the host
// needs. So a bundle that throws on require — or default-exports the wrong shape — is first discovered
// by the host at install, after the tag and the GitHub Release are already published. Run after a build.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverPluginDirs } from './run-tests.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function assertLoadable(mod, id) {
  const Plugin = mod?.default;
  if (typeof Plugin !== 'function') {
    throw new Error(`${id}: dist/index.js does not default-export a constructor (got ${typeof Plugin})`);
  }
  let instance;
  try {
    instance = new Plugin();
  } catch (err) {
    throw new Error(`${id}: the default export threw on construction — ${err.message}`);
  }
  // onEnable is the one method every plugin in the catalog implements and the host always calls.
  if (typeof instance.onEnable !== 'function') {
    throw new Error(`${id}: the default export has no onEnable() — the host cannot run it as a plugin`);
  }
}

// Only run when invoked directly (assertLoadable is imported by scripts/loader-check.test.mjs).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const require = createRequire(import.meta.url);
  const all = discoverPluginDirs(ROOT);
  // Discovery returning nothing would otherwise report success having loaded not one bundle.
  if (all.length === 0) {
    console.error('✗ no plugin directories discovered — nothing was checked');
    process.exit(1);
  }

  // Optional plugin id: the release workflow builds one plugin, so checking all ten would only report
  // nine missing bundles. Filtered from discovery rather than trusted, so a typo fails loudly.
  const requested = process.argv[2];
  const dirs = requested ? all.filter((d) => d === requested) : all;
  if (requested && dirs.length === 0) {
    console.error(`✗ no plugin directory named "${requested}"`);
    process.exit(1);
  }

  const failures = [];
  for (const id of dirs) {
    const bundle = join(ROOT, id, 'dist', 'index.js');
    if (!existsSync(bundle)) {
      failures.push(`${id}: dist/index.js is missing — run \`npm run build\` first`);
      continue;
    }
    // require() is separated from the shape check so a bundle that throws on load is still reported
    // against the plugin it belongs to — a bare "missing dependency" names nothing across ten plugins.
    let mod;
    try {
      mod = require(bundle);
    } catch (err) {
      failures.push(`${id}: dist/index.js threw on require — ${err.message}`);
      continue;
    }
    try {
      assertLoadable(mod, id);
    } catch (err) {
      failures.push(err.message);
    }
  }

  if (failures.length) {
    for (const f of failures) console.error(`✗ ${f}`);
    process.exit(1);
  }
  console.log(`Loader contract OK (${dirs.length} plugin(s)).`);
}

/**
 * Is the plugin Photoshop is running the code on disk?
 *
 * Photoshop caches a loaded plugin: installing a new build does not replace the one
 * already in memory, and the only symptom is that a fix appears to do nothing. That
 * was read twice as "the fix is wrong" before it was read as "the fix was never
 * loaded", so the question gets a script.
 *
 * Prints the build id of the sources on disk and the one the running plugin
 * reported, and says plainly whether they match.
 *
 *   node scripts/check-plugin-build.mjs
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = 'photoshop-plugin';

/** The same walk install-plugin.sh hashes, so the two agree by construction. */
function buildIdOnDisk() {
  const files = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'test' || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      // Its own output; hashing it would make the stamp a function of itself.
      if (entry.name === 'build-info.js') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.push(relative(ROOT, path));
    }
  })(ROOT);

  const hash = createHash('sha256');
  for (const file of files.sort()) {
    hash.update(file);
    hash.update(readFileSync(join(ROOT, file)));
  }
  return hash.digest('hex').slice(0, 12);
}

const disk = buildIdOnDisk();
const stampPath = join(ROOT, 'lib', 'build-info.js');
const installed = existsSync(stampPath)
  ? (readFileSync(stampPath, 'utf8').match(/buildId: '([^']+)'/) ?? [])[1]
  : undefined;

const logPath = process.env.PLUGIN_LOG
  ?? '/mnt/c/Users/maxim/AppData/Roaming/Adobe/UXP/PluginsStorage/PHSP/26/External/com.blkdem.photoshop-ai-studio/PluginData/ai-studio.log';
const mcpLog = process.env.MCP_LOG ?? 'logs/mcp.log';

let running;
let connected = false;
if (existsSync(mcpLog)) {
  const text = readFileSync(mcpLog, 'utf8');
  const matches = [...text.matchAll(/plugin build ([0-9a-f]{12})/g)];
  running = matches.length > 0 ? matches[matches.length - 1][1] : undefined;
  // A plugin that connected without a buildId is the specific case worth naming:
  // it is running a build from before the stamp existed.
  connected = /Connected to photoshop/.test(text);
}

console.log(`sources on disk : ${disk}`);
console.log(`installed stamp : ${installed ?? '(not installed)'}`);
console.log(`running plugin  : ${running ?? '(no hello in the mcp log yet)'}`);
void logPath;

if (!running) {
  console.log(
    connected
      ? '\nMISMATCH, and no worse than expected: the plugin connected without a buildId, so it is running a\n' +
          'build from before the stamp existed. The code on disk is newer than the code in memory.'
      : '\nUnknown: no plugin has connected to this log yet.',
  );
  if (connected) process.exitCode = 1;
} else if (running === disk) {
  console.log('\nMatch. Photoshop is running the code on disk.');
} else {
  console.log('\nMISMATCH. Photoshop is running older code than is on disk.');
  console.log('This is expected right after an install: the plugin loads once per Photoshop session.');
  console.log('Restart Photoshop, or reload the plugin, before judging any change.');
  process.exitCode = 1;
}

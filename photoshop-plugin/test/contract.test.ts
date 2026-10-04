import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { BRIDGE_PROTOCOL_VERSION, OP_NAMES, TOOL_META } from '@photoshop-ai-studio/shared';

/**
 * Plugin / shared contract tests.
 *
 * The UXP plugin cannot be imported here (it calls `require('photoshop')`), so
 * these tests read it as source and assert the properties that must hold for the
 * two sides to stay in step. That catches the failure this project is most
 * exposed to — adding a Photoshop capability in `shared` and forgetting to
 * implement it inside the plugin.
 */

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string): string => readFileSync(join(pluginRoot, relative), 'utf8');

/** Removes block and line comments so assertions read the code, not the prose. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Operation names declared in the adapter's dispatch table. */
function implementedOps(): string[] {
  const source = read('lib/adapter.js');
  const table = source.slice(source.indexOf('var OPERATIONS = {'), source.indexOf('};', source.indexOf('var OPERATIONS = {')));
  return [...table.matchAll(/^\s{2}([a-z_0-9]+):\s/mg)].map((m) => m[1]!);
}

interface ManifestIcon {
  path: string;
  width: number;
  height: number;
}

interface ManifestEntrypoint {
  type: string;
  id: string;
  icons?: ManifestIcon[];
}

interface Manifest {
  manifestVersion: number;
  host: { app: string; minVersion: string; data: { apiVersion: number; loadEvent: string } };
  entrypoints: ManifestEntrypoint[];
  icons: ManifestIcon[];
  requiredPermissions: { network: { domains: string[] }; localFileSystem: string };
}

describe('manifest', () => {
  const manifest = JSON.parse(read('manifest.json')) as Manifest;

  it('targets Photoshop 25+ with the modal-JavaScript model', () => {
    expect(manifest.host.app).toBe('PS');
    expect(manifest.host.minVersion).toBe('25.0.0');
    expect(manifest.host.data.apiVersion).toBe(2);
    expect(manifest.host.data.loadEvent).toBe('startup');
  });

  it('uses manifest v5 with an explicit network allow-list', () => {
    expect(manifest.manifestVersion).toBe(5);
    // UXP is a WebSocket *client*: the loopback origins must be declared with an
    // explicit scheme and a trailing slash or Photoshop refuses the connection.
    for (const domain of ['ws://localhost/', 'http://localhost/', 'ws://127.0.0.1/', 'http://127.0.0.1/']) {
      expect(manifest.requiredPermissions.network.domains, domain).toContain(domain);
    }
    expect(manifest.requiredPermissions.localFileSystem).toBe('request');
  });

  it('declares the panel and the reconnect command', () => {
    expect(manifest.entrypoints.map((e) => `${e.type}:${e.id}`)).toEqual(['panel:aiStudioPanel', 'command:aiStudioReconnect']);
  });

  it('references icon files that exist', () => {
    const icons = [...manifest.icons, ...(manifest.entrypoints[0]?.icons ?? [])];
    expect(icons.length).toBeGreaterThan(0);
    for (const icon of icons) {
      expect(statSync(join(pluginRoot, icon.path)).size, icon.path).toBeGreaterThan(0);
    }
  });
});

describe('plugin / shared contract', () => {
  /**
   * Diagnostics that exist only to answer a question about this host — which
   * route actually fills a layer, whether an API is present. They are reached by
   * name over the bridge and must not appear in the tool surface: an operation a
   * planner can select is a promise the project then has to keep.
   */
  const DIAGNOSTIC_PREFIX = 'probe_';

  it('implements every operation declared in the shared registry', () => {
    const implemented = new Set(implementedOps());
    const missing = OP_NAMES.filter((op) => !implemented.has(op));
    expect(missing, `the plugin does not implement: ${missing.join(', ')}`).toEqual([]);
  });

  it('implements nothing that the shared registry does not declare', () => {
    const extra = implementedOps().filter(
      (op) => !op.startsWith(DIAGNOSTIC_PREFIX) && !(OP_NAMES as readonly string[]).includes(op),
    );
    expect(extra, `unknown operations in the plugin: ${extra.join(', ')}`).toEqual([]);
  });

  it('agrees with the server on the bridge protocol version', () => {
    const bridge = read('lib/bridge.js');
    expect(bridge).toContain(`var PROTOCOL_VERSION = ${BRIDGE_PROTOCOL_VERSION}`);
  });

  it('is plain JavaScript with no build step and no npm dependency', () => {
    // Photoshop loads these files directly, so a `.ts` file or an npm import
    // would only work on the developer's machine.
    expect(readdirSync(pluginRoot).filter((f) => f.endsWith('.ts'))).toEqual([]);
    // No package.json either: npm must not treat the plugin as a workspace.
    expect(existsSync(join(pluginRoot, 'package.json'))).toBe(false);

    const walk = (dir: string): void => {
      for (const entry of readdirSync(join(pluginRoot, dir))) {
        const relative = `${dir}/${entry}`;
        if (statSync(join(pluginRoot, relative)).isDirectory()) {
          walk(relative);
          continue;
        }
        if (!entry.endsWith('.js')) continue;
        for (const match of read(relative).matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
          const dependency = match[1]!;
          const isHostModule = dependency === 'photoshop' || dependency === 'uxp';
          const isRelative = dependency.startsWith('./') || dependency.startsWith('../');
          expect(isHostModule || isRelative, `${relative} requires "${dependency}"`).toBe(true);
        }
      }
    };
    walk('lib');
    for (const match of read('index.js').matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
      const dependency = match[1]!;
      // Host modules plus our own files — nothing from npm.
      expect(
        dependency === 'uxp' || dependency === 'photoshop' || dependency.startsWith('./'),
        `index.js requires "${dependency}"`,
      ).toBe(true);
    }
  });

  it('routes every mutation through a modal scope', () => {
    const adapter = stripComments(read('lib/adapter.js'));
    expect(adapter).toContain('ps.asModal(');
    // Read-only operations must not open one, and the rest must.
    expect(adapter).toMatch(/READ_ONLY\[op\]/);
    expect(adapter).toMatch(/else \{\s*work = ps\.asModal/);
  });

  it('inspects batchPlay results for error descriptors', () => {
    // `await batchPlay` resolves even when Photoshop refuses the command; the
    // refusal arrives as an item whose `_obj` is "error".
    const ps = stripComments(read('lib/ps.js'));
    expect(ps).toContain("item._obj === 'error'");
    expect(ps).toContain('photoshopFailure');
  });

  it('never calls batchPlay outside the sanctioned files', () => {
    // `lib/ps.js` is the wrapper that runs and inspects descriptors;
    // `lib/ops/*` are the individual operations; `lib/demo.js` is the panel's
    // demo-document builder, which is deliberately NOT an MCP tool.
    const SANCTIONED = ['lib/ps.js', 'lib/demo.js'];
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(join(pluginRoot, dir))) {
        const relative = `${dir}/${entry}`;
        if (statSync(join(pluginRoot, relative)).isDirectory()) {
          if (entry === 'test') continue;
          walk(relative);
          continue;
        }
        if (!entry.endsWith('.js')) continue;
        const code = stripComments(read(relative));
        if (code.includes('.batchPlay(') && !relative.startsWith('lib/ops/') && !SANCTIONED.includes(relative)) {
          offenders.push(relative);
        }
      }
    };
    walk('lib');
    if (stripComments(read('index.js')).includes('.batchPlay(')) offenders.push('index.js');

    expect(offenders, `batchPlay outside the sanctioned files: ${offenders.join(', ')}`).toEqual([]);
  });

  it('uses the documented UXP export path, not the ExtendScript one', () => {
    const images = read('lib/ops/images.js');
    expect(images).toContain('saveAs.png');
    expect(images).toContain('saveAs.jpg');
    expect(images).toContain('saveAs.psd');
    // `document.exportDocument` is ExtendScript and does not exist in UXP, so
    // the plugin must only ever reach an export through `saveAs.<format>`.
    // Comments may of course mention it.
    const code = stripComments(images);
    expect(code).not.toMatch(/\.exportDocument\s*\(/);
    expect(code).toMatch(/saveAs\.(png|jpg|psd)\s*\(/);
  });

  it('calls entrypoints.setup synchronously at the top level', () => {
    const index = read('index.js');
    const setupAt = index.indexOf('entrypoints.setup(');
    expect(setupAt).toBeGreaterThan(-1);
    // Nothing may precede it: a deferred setup throws an uncatchable error.
    const before = index.slice(0, setupAt);
    expect(before).not.toMatch(/\bawait\b/);
    expect(before).not.toMatch(/entrypoints\.setup[\s\S]*entrypoints\.setup/);
  });

  it('uses addEventListener rather than innerHTML handlers', () => {
    // Inline handlers need allowCodeGenerationFromStrings, which we do not ask for.
    const index = read('index.js');
    expect(index).toContain('addEventListener');
    expect(index).not.toMatch(/on(click|change|input)\s*=/);
  });

  it('enforces the workspace allow-list on the Photoshop side too', () => {
    const ps = read('lib/ps.js');
    expect(ps).toContain('function assertInsideWorkspace');
    expect(read('lib/ops/images.js')).toContain('entryForWriting');
    expect(read('lib/ops/images.js')).toContain('entryForReading');
  });

  it('mirrors the shared error taxonomy', () => {
    const source = read('lib/errors.js');
    for (const code of ['LAYER_NOT_FOUND', 'PATH_NOT_ALLOWED', 'FILE_EXISTS', 'NOT_A_TEXT_LAYER', 'LAYER_LOCKED']) {
      expect(source, code).toContain(`${code}:`);
    }
    // `recoverable` is what the repair loop reads.
    expect(source).toContain('recoverable');
  });

  it('carries the recoverable flag the AI needs to decide on a repair', () => {
    // Every tool the registry marks destructive is confirmation-gated upstream;
    // the plugin must not need to know that, only report facts faithfully.
    for (const tool of TOOL_META.filter((t) => t.destructive)) {
      expect(tool.requiresConfirmation).toBe(true);
    }
  });
});

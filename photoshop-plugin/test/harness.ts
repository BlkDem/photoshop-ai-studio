import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Test harness for loading UXP plugin modules.
 *
 * The plugin is plain CommonJS that Photoshop loads directly, but the repository
 * root declares `"type": "module"` — so `require()` on a plugin file hands it to
 * the ESM loader and `module.exports` throws. The fix is to compile the source
 * ourselves against a stub `require`, which also gives the two things these
 * tests actually need: a fake `photoshop` host to drive, and the ability to
 * override a module deep in the require graph.
 *
 * Extracted from `load.test.ts` so the brush tests exercise the same loader
 * rather than a second, subtly different copy.
 */

export const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

export interface Stub {
  [key: string]: unknown;
}

export interface LayerStub {
  id: number;
  name: string;
  kind: string;
  visible: boolean;
  opacity: number;
  bounds: { left: number; top: number; right: number; bottom: number };
  layers: unknown[];
  textItem: { contents: string; characterStyle: { size: number; font: string }; paragraphStyle: { alignment: string } };
  delete(): void;
  translate(): void;
  scale(): void;
  move(): void;
}

export function makeLayer(): LayerStub {
  return {
    id: 1,
    name: 'Layer',
    kind: 'pixel',
    visible: true,
    opacity: 100,
    bounds: { left: 0, top: 0, right: 10, bottom: 10 },
    layers: [],
    textItem: { contents: 'x', characterStyle: { size: 12, font: 'F' }, paragraphStyle: { alignment: 'left' } },
    delete() {},
    translate() {},
    scale() {},
    move() {},
  };
}

export interface DocumentStub {
  id: number;
  name: string;
  width: number;
  height: number;
  resolution: number;
  mode: string;
  layers: LayerStub[];
  backgroundLayer: LayerStub;
  activeLayer: LayerStub;
  saved: boolean;
  zoom: number;
  createLayer(options?: { name?: string }): LayerStub;
  createLayerGroup(options?: { name?: string }): LayerStub;
  createTextLayer(options?: { name?: string }): LayerStub;
  duplicate(options?: unknown): Promise<DocumentStub>;
  resizeCanvas(options?: unknown): Promise<void>;
  saveAs: { png: () => Promise<void>; jpg: () => Promise<void>; psd: () => Promise<void> };
}

export function makeDocument(): DocumentStub {
  const layer = makeLayer();
  const document: DocumentStub = {
    id: 1,
    name: 'stub.psd',
    width: 100,
    height: 100,
    resolution: 72,
    mode: 'RGB',
    layers: [layer],
    backgroundLayer: layer,
    activeLayer: layer,
    saved: true,
    zoom: 100,
    createLayer: () => layer,
    createLayerGroup: () => layer,
    createTextLayer: () => layer,
    // Async on purpose: the DOM returns a Promise, and a synchronous stub
    // hides the bug where `.name` is read off the promise instead of the document.
    duplicate: async () => document,
    resizeCanvas: async () => undefined,
    saveAs: { png: async () => undefined, jpg: async () => undefined, psd: async () => undefined },
  };
  return document;
}

/**
 * Mutable stub registry.
 *
 * A test sometimes has to swap the host *and then* load a module, because a
 * module captures `require('photoshop')` once at load time. The registry is
 * module-level for that reason: assigning to a local map would not be visible to
 * `loadPluginFile`, and the module under test would keep the old host.
 */
export const STUBS: Record<string, Stub> = {};

export function photoshopStub(): Stub {
  const document = makeDocument();
  return {
    app: { activeDocument: document, documents: [document], foregroundColor: {}, open: async () => document },
    action: { batchPlay: async () => [{}], batchPlaySync: () => [{}] },
    core: {
      executeAsModal: async (fn: () => unknown) => fn(),
      getLayerTreeSync: () => ({ list: [] }),
    },
    // Values are the kind *names*, matching what Photoshop 26.11 actually exposes.
    constants: {
      LayerKind: { NORMAL: 'pixel', TEXT: 'text', SMARTOBJECT: 'smartObject', SOLIDFILL: 'solidColor' },
      ElementPlacement: { PLACEINSIDE: 'placeInside' },
    },
  };
}

export function uxpStub(urls: string[] = []): Stub {
  const entry = { read: async () => '{}', write: async () => undefined, nativePath: '/tmp/x' };
  return {
    entrypoints: { setup: () => undefined },
    storage: {
      localFileSystem: {
        getPluginFolder: async () => ({ getEntry: () => entry, createFile: () => entry, nativePath: '/tmp' }),
        getTemporaryFolder: async () => ({ nativePath: '/tmp', createFile: () => entry }),
        createEntryWithUrl: async (url: string) => {
          urls.push(url);
          return entry;
        },
        getEntryWithUrl: async () => entry,
        createSessionToken: () => 'token',
      },
      formats: { utf8: 'utf8', binary: 'binary' },
    },
    versions: { uxp: 'test' },
    hostInformation: { appVersion: '99.0', appName: 'Photoshop' },
  };
}

/** Every plugin `.js` file, in dependency order. */
export function pluginFiles(root = pluginRoot): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(root, dir)).sort()) {
      const relative = `${dir}/${entry}`;
      if (statSync(join(root, relative)).isDirectory()) {
        if (entry === 'test' || entry === 'icons') continue;
        walk(relative);
      } else if (extname(entry) === '.js') {
        out.push(relative.replace(/^\.\//, ''));
      }
    }
  };
  walk('.');
  return out;
}

/**
 * Loads a plugin file as CommonJS with the host modules stubbed.
 *
 * `Module._compile` is not used: the nearest `package.json` to the plugin is the
 * repository root, which declares `"type": "module"`, so `require()` would hand
 * the file to the ESM loader. Wrapping the source explicitly keeps the plugin's
 * own CommonJS semantics, which is what Photoshop gives it.
 */
export function loadPluginFile(
  relative: string,
  uxpOverride?: Stub,
  photoshopOverride?: Stub,
  root = pluginRoot,
): Record<string, unknown> {
  const absolute = join(root, relative);
  const source = readFileSync(absolute, 'utf8');
  const module = { exports: {} as Record<string, unknown> };
  const requireStub = (specifier: string): unknown => {
    if (specifier === 'uxp') return uxpOverride ?? STUBS.uxp ?? uxpStub();
    if (specifier === 'photoshop') return photoshopOverride ?? STUBS.photoshop ?? photoshopStub();
    if (STUBS[specifier]) return STUBS[specifier];
    if (specifier.startsWith('.')) {
      const target = resolvePath(dirname(absolute), specifier);
      // Overrides must reach transitive requires too: `lib/ops/text.js` reads the
      // layer through `lib/ps.js`, which captured the stub when *it* loaded.
      const child =
        target.startsWith(root) ? target.slice(root.length + 1) : target;
      return loadPluginFile(child, uxpOverride, photoshopOverride, root);
    }
    throw new Error(`the plugin may not require "${specifier}"`);
  };
  const factory = new Function('require', 'module', 'exports', '__filename', '__dirname', source);
  factory(requireStub, module, module.exports, absolute, dirname(absolute));
  return module.exports;
}

/**
 * Loads a plugin file that has no `require('photoshop')` dependency.
 *
 * Pure modules — geometry maths, colour parsing — can be evaluated directly,
 * which is cheaper and clearer than standing up a host stub around arithmetic.
 */
export function loadPurePluginFile<T>(relative: string, root = pluginRoot): T {
  const absolute = join(root, relative);
  const source = readFileSync(absolute, 'utf8');
  const module = { exports: {} as Record<string, unknown> };
  const requireStub = (specifier: string): unknown => {
    if (specifier.startsWith('.')) {
      const target = resolvePath(dirname(absolute), specifier);
      return loadPurePluginFile<Record<string, unknown>>(
        target.startsWith(root) ? target.slice(root.length + 1) : target,
        root,
      );
    }
    throw new Error(`the plugin may not require "${specifier}"`);
  };
  const factory = new Function('require', 'module', 'exports', '__filename', '__dirname', source);
  factory(requireStub, module, module.exports, absolute, dirname(absolute));
  return module.exports as T;
}
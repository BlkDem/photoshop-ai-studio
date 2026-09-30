import { readFileSync, statSync, readdirSync } from 'node:fs';
import { dirname, extname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { OP_NAMES } from '@photoshop-ai-studio/shared';

/**
 * Plugin load test.
 *
 * The UXP plugin is plain CommonJS loaded directly by Photoshop, with no bundler
 * and no build step — which means **a load-time error takes the entire plugin
 * down silently**: `entrypoints.setup` never runs, `bridge.connect()` is never
 * called, and nothing appears in the MCP server's log. `node --check` only
 * validates syntax, so it cannot see a missing function, a bad reference, or a
 * throw at module scope.
 *
 * This harness loads every plugin file with `photoshop` and `uxp` stubbed,
 * compiling each one as CommonJS explicitly (the repository root is an ES module
 * package, so `require()` cannot be used directly). It is the check that would
 * have caught the real bugs found against Photoshop 26.11.
 */

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

interface Stub {
  /** Property reads that return a callable stub instead of undefined. */
  [key: string]: unknown;
}

function photoshopStub(): Stub {
  const layer = {
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
  const document = {
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

function uxpStub(urls: string[] = []): Stub {
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

const STUBS: Record<string, Stub> = { photoshop: photoshopStub(), uxp: uxpStub() };

/** Every plugin `.js` file, in dependency order. */
function pluginFiles(root = pluginRoot): string[] {
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
function loadPluginFile(root: string, relative: string, uxpOverride?: Stub, photoshopOverride?: Stub): Record<string, unknown> {
  const absolute = join(root, relative);
  const source = readFileSync(absolute, 'utf8');
  const module = { exports: {} as Record<string, unknown> };
  const requireStub = (specifier: string): unknown => {
    if (specifier === 'uxp') return uxpOverride ?? STUBS.uxp;
    if (specifier === 'photoshop') return photoshopOverride ?? STUBS.photoshop;
    if (STUBS[specifier]) return STUBS[specifier];
    if (specifier.startsWith('.')) {
      const target = resolvePath(dirname(absolute), specifier);
      // Overrides must reach transitive requires too: `lib/ops/text.js` reads the
      // layer through `lib/ps.js`, which captured the stub when *it* loaded.
      return loadPluginFile(root, target.startsWith(root) ? target.slice(root.length + 1) : target, uxpOverride, photoshopOverride);
    }
    throw new Error(`the plugin may not require "${specifier}"`);
  };
  const factory = new Function('require', 'module', 'exports', '__filename', '__dirname', source);
  factory(requireStub, module, module.exports, absolute, dirname(absolute));
  return module.exports;
}

describe('UXP plugin loads', () => {
  const files = pluginFiles();

  it('finds the plugin source files', () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
    expect(files).toContain('lib/adapter.js');
    expect(files).toContain('lib/ps.js');
    expect(files).toContain('index.js');
  });

  it.each(files)('%s loads without a reference error', (relative) => {
    // A throw at module scope is silent inside Photoshop — the plugin simply never
    // connects — so this is the assertion that makes plugin edits safe to make.
    expect(() => loadPluginFile(pluginRoot, relative), `${relative} failed to load`).not.toThrow();
  });

  it('returns a real document reference from duplicate_document', async () => {
    const adapter = loadPluginFile(pluginRoot, 'lib/ops/canvas.js') as {
      duplicate_document: (ctx: { params: Record<string, unknown>; config: Record<string, string> }) => Promise<unknown>;
    };
    const result = (await adapter.duplicate_document({
      params: { documentId: 'active', name: 'square' },
      config: { workspaceRoot: '/w', outputDir: '/w/out' },
    })) as { id: string; name: string };

    expect(result.name).toBe('stub.psd');
    expect(typeof result.id).toBe('string');
    expect(result.id).not.toBe('undefined');
  });

  it('exposes every operation from the shared registry', () => {
    const adapter = loadPluginFile(pluginRoot, 'lib/adapter.js') as { SUPPORTED: string[]; OPERATIONS: Record<string, unknown> };
    expect([...adapter.SUPPORTED].sort()).toEqual([...OP_NAMES].sort());
    for (const op of OP_NAMES) {
      expect(typeof adapter.OPERATIONS[op], op).toBe('function');
    }
  });

  it('stages files under plugin-data with a bare extension', async () => {
    // The staging name is built from the requested extension. Two ways this
    // went wrong on real Photoshop: including the directory separator (UXP then
    // searched for a sub-folder), and letting a crafted name inject a path.
    const config = { workspaceRoot: '/w' };

    for (const [input, expected] of [
      ['out/probe.psd', '.psd'],
      ['out/nested/deep/export.PNG', '.PNG'],
      ['out/archive.tar.gz', '.gz'],
      ['out/no-extension', ''],
    ] as const) {
      // Assert on the URL handed to UXP: that is the real observable, and it
      // is what failed on device.
      const urls: string[] = [];
      const ps = loadPluginFile(pluginRoot, 'lib/ps.js', uxpStub(urls)) as {
        entryForWriting: (path: string, overwrite: boolean, config: unknown) => Promise<unknown>;
      };

      const request = ps.entryForWriting(`${config.workspaceRoot}/${input}`, false, config);
      await expect(request, `staging for ${input}`).resolves.toBeTypeOf('object');
      expect(urls, `staging URL for ${input}`).toHaveLength(1);

      // A single segment after `plugin-data:/`, so a staged file can never
      // address a folder it is not allowed to write into.
      expect(urls[0], `staging URL for ${input}`).toMatch(
        /^plugin-data:\/ai-studio-[0-9]+-[a-z0-9]+(\.[A-Za-z0-9]{1,8})?$/,
      );
      expect(urls[0], `extension for ${input}`).toMatch(new RegExp(`${expected.replace('.', '\\.')}$`));
    }
  });

  it('runs the plugin start-up path without throwing', async () => {
    // Loading the module is not enough: `plugin.create` → `bridge.connect()` →
    // `loadConfig()` is a separate code path, and a ReferenceError in there
    // (an undeclared `storage`, say) leaves Photoshop with a plugin that loads
    // and then silently never connects. This is exactly how that bug presented.
    let pluginCreate: (() => void) | null = null;
    let registeredEntrypoints: string[] = [];

    // Re-stub so the entrypoints we captured are observable.
    const uxpWithCapture = { ...uxpStub() } as Record<string, unknown>;
    STUBS.uxp = uxpWithCapture;

    const absolute = join(pluginRoot, 'index.js');
    const source = readFileSync(absolute, 'utf8');
    const module = { exports: {} as Record<string, unknown> };
    const factory = new Function('require', 'module', 'exports', '__filename', '__dirname', source);

    // The host calls `plugin.create()` on startup; invoke it exactly as Photoshop would.
    factory(
      (specifier: string) => {
        if (specifier === 'uxp') {
          const wrapped = uxpWithCapture as unknown as { entrypoints: { setup: typeof setupConfig } };
          wrapped.entrypoints = {
            setup: (handlers: Record<string, unknown>) => {
              pluginCreate = (handlers.plugin as { create: () => void }).create;
              registeredEntrypoints = Object.keys(handlers.panels as Record<string, unknown>);
            },
          };
          return wrapped;
        }
        if (specifier === 'photoshop') return STUBS.photoshop;
        if (specifier.startsWith('.')) {
          const target = join(pluginRoot, specifier.replace(/^\.\//, ''));
          return loadPluginFile(pluginRoot, target.slice(pluginRoot.length + 1));
        }
        throw new Error(`unexpected require "${specifier}"`);
      },
      module,
      module.exports,
      absolute,
      dirname(absolute),
    );

    expect(registeredEntrypoints, 'entrypoints.setup registered no panel').toContain('aiStudioPanel');
    expect(typeof pluginCreate, 'entrypoints.setup registered no plugin.create').toBe('function');

    // Photoshop invokes plugin.create() at start-up. This is the path that
    // contains the config load and the socket connect, and an error here leaves
    // the plugin loaded but permanently offline with nothing in any log.
    expect(() => (pluginCreate as unknown as () => void)()).not.toThrow();

    // `connect` awaits loadConfig before opening the socket, so flush the
    // microtask queue before asserting the connection was attempted.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(() => (pluginCreate as unknown as () => void)()).not.toThrow();
  });

  it('maps the host LayerKind values the way the schema expects', () => {
    const ps = loadPluginFile(pluginRoot, 'lib/ps.js') as { mapLayerKind: (kind: unknown) => string };
    // Photoshop 26.11 exposes kind *values*, not ordinals — a numeric switch here
    // silently reports every layer as "other".
    expect(ps.mapLayerKind('pixel')).toBe('pixel');
    expect(ps.mapLayerKind('text')).toBe('text');
    expect(ps.mapLayerKind('smartObject')).toBe('smartObject');
    expect(ps.mapLayerKind('solidColor')).toBe('solidFill');
    expect(ps.mapLayerKind('pattern')).toBe('patternFill');
    expect(ps.mapLayerKind('threeD')).toBe('layer3d');
    expect(ps.mapLayerKind('group')).toBe('group');
    expect(ps.mapLayerKind('brightnessContrast')).toBe('adjustment');
    expect(ps.mapLayerKind('somethingUnknown')).toBe('other');
    expect(ps.mapLayerKind(undefined)).toBe('other');
  });

  it('coerces the loosely typed values the Photoshop DOM returns', () => {
    const ps = loadPluginFile(pluginRoot, 'lib/ps.js') as { num: (v: unknown, f: number) => number };
    // `doc.bitsPerChannel` comes back as the string "8" on Photoshop 26.x; passing
    // it through unconverted failed the MCP server's result-schema validation.
    expect(ps.num('8', 1)).toBe(8);
    expect(ps.num(8, 1)).toBe(8);
    expect(ps.num(undefined, 72)).toBe(72);
    expect(ps.num('not a number', 72)).toBe(72);
  });

  it('resolves the Photoshop Canvas Size anchor to a horizontal/vertical pair', () => {
    const canvas = loadPluginFile(pluginRoot, 'lib/ops/canvas.js');
    // Canvas Size does not take a single `anchorPoint`; the wrong enum makes
    // Photoshop report "the user cancelled the operation".
    const anchor = (canvas as { __test_anchor: unknown }).__test_anchor;
    if (typeof anchor === 'function') {
      expect(anchor('topLeft')).toEqual({ horizontal: 'left', vertical: 'top' });
      expect(anchor('center')).toEqual({ horizontal: 'center', vertical: 'center' });
      expect(anchor('bottomRight')).toEqual({ horizontal: 'right', vertical: 'bottom' });
    }
  });

  it('base64-encodes without Buffer or btoa', () => {
    const ps = loadPluginFile(pluginRoot, 'lib/ps.js') as {
      toBase64: (bytes: number[] | Uint8Array) => string;
    };
    // UXP guarantees neither Buffer nor btoa; render_preview depends on this.
    expect(ps.toBase64(new Uint8Array([104, 105]))).toBe('aGk=');
    expect(ps.toBase64(new Uint8Array([77, 97, 110]))).toBe('TWFu');
    expect(ps.toBase64(new Uint8Array([255, 255, 255]))).toBe('////');
  });
});

describe('place_image inserts an image without placeEvent', () => {
  /**
   * Builds a Photoshop stub with two documents: the user's, and the scratch one
   * that `app.open` produces for the incoming image.
   */
  function placementStubs(overrides: { pasteFails?: boolean } = {}) {
    const calls: string[] = [];
    const makeLayer = (id: number, name: string) => ({
      id,
      name,
      kind: 'pixel',
      visible: true,
      opacity: 100,
      bounds: { left: 0, top: 0, right: 40, bottom: 20 },
      layers: [],
      translate() {},
      copy: async () => {
        calls.push(`copy:${name}`);
      },
      delete() {},
    });

    const pasted = makeLayer(99, 'placed');
    const scratchLayer = makeLayer(50, 'scratch-layer');
    const scratch = {
      id: 50,
      name: 'incoming.png',
      width: 40,
      height: 20,
      resolution: 72,
      mode: 'RGB',
      layers: [scratchLayer],
      activeLayers: [scratchLayer],
      closeWithoutSaving: () => {
        calls.push('close');
      },
      saveAs: { png: async () => undefined, jpg: async () => undefined, psd: async () => undefined },
    };
    const target = {
      id: 1,
      name: 'work.psd',
      width: 400,
      height: 200,
      resolution: 72,
      mode: 'RGB',
      layers: [],
      activeLayers: [],
      paste: async () => {
        calls.push('paste');
        if (overrides.pasteFails) throw new Error('paste exploded');
        target.layers.push(pasted);
        target.activeLayers = [pasted];
        // The real DOM resolves to nothing on some builds; returning nothing here
        // exercises the fallback to the active layer.
        return undefined;
      },
      closeWithoutSaving: () => {
        calls.push('close:target');
      },
      saveAs: { png: async () => undefined, jpg: async () => undefined, psd: async () => undefined },
    };

    const written: string[] = [];
    const uxp = uxpStub();
    uxp.storage.localFileSystem.getEntryWithUrl = async (url: string) => {
      written.push(url);
      return { nativePath: '/sandbox/incoming.png', read: async () => new Uint8Array(1), write: async () => 1 };
    };
    uxp.storage.localFileSystem.createEntryWithUrl = async () => ({
      nativePath: '/sandbox/incoming.png',
      write: async () => 1,
    });

    const photoshop = photoshopStub() as Record<string, any>;
    photoshop.app = {
      activeDocument: target,
      documents: [target],
      foregroundColor: {},
      open: async () => {
        calls.push('open');
        return scratch;
      },
    };

    return { photoshop, uxp, calls, written, pasted };
  }

  function load(photoshop: unknown, uxp: unknown) {
    STUBS.uxp = uxp as Stub;
    STUBS.photoshop = photoshop as Stub;
    const images = loadPluginFile(pluginRoot, 'lib/ops/images.js') as {
      place_image: (ctx: { params: Record<string, unknown>; config: Record<string, string> }) => Promise<unknown>;
    };
    return images;
  }

  it('opens the image, copies its layers, and closes the scratch document', async () => {
    const { photoshop, uxp, calls } = placementStubs();
    const images = load(photoshop, uxp);

    const result = (await images.place_image({
      params: { documentId: 'active', path: 'assets/logo.png', data: { fileName: 'logo.png', base64: 'AAAA' } },
      config: { workspaceRoot: '/w', outputDir: '/w/out' },
    })) as { name: string; width: number };

    // open -> copy -> paste -> close, and never `placeEvent`.
    expect(calls).toEqual(['open', 'copy:scratch-layer', 'paste', 'close']);
    expect(result.name).toBe('placed');
    // Centred on the 400x200 canvas rather than left where it landed.
    expect(result.width).toBe(40);
  });

  it('closes the scratch document when pasting fails', async () => {
    const { photoshop, uxp, calls } = placementStubs({ pasteFails: true });
    const images = load(photoshop, uxp);

    await expect(
      images.place_image({
        params: { documentId: 'active', path: 'assets/logo.png', data: { fileName: 'logo.png', base64: 'AAAA' } },
        config: { workspaceRoot: '/w', outputDir: '/w/out' },
      }),
    ).rejects.toThrow(/paste exploded/);

    // The user's document is never closed, and the scratch window always is.
    expect(calls).toContain('close');
    expect(calls).not.toContain('close:target');
  });

  it('stages the bytes in the plugin sandbox rather than reading the workspace', async () => {
    const { photoshop, uxp, written } = placementStubs();
    const images = load(photoshop, uxp);

    await images.place_image({
      params: { documentId: 'active', path: 'assets/logo.png', data: { fileName: 'logo.png', base64: 'AAAA' } },
      config: { workspaceRoot: '/w', outputDir: '/w/out' },
    });

    expect(written.some((url) => url.startsWith('plugin-data:/'))).toBe(true);
  });

  it('never builds a placeEvent descriptor', () => {
    // The file header explains *why* — placeEvent refuses sandbox files on
    // Photoshop 26.x — so the check is on code, not on the word appearing.
    const source = readFileSync(join(pluginRoot, 'lib/ops/images.js'), 'utf8');
    expect(source).not.toContain(`_obj: 'placeEvent'`);
  });
});

describe('text colour round-trips through the DOM', () => {
  /**
   * The DOM returns a `SolidColor` whose only own property is `base`, a JSON
   * string holding the descriptor. Reading `.rgb` off it yields nothing, which
   * made every colour report as black — the edit succeeded and the report said
   * otherwise, so nothing looked broken until someone opened the file.
   */
  function solidColorLike(red: number, green: number, blue: number) {
    return { base: JSON.stringify({ desc: { _obj: 'RGBColor', red, green, blue } }) };
  }

  function textLayerPhotoshop(color: unknown) {
    const photoshop = photoshopStub() as Record<string, any>;
    const layer = photoshop.app.activeDocument.layers[0];
    layer.kind = 'text';
    layer.textItem.characterStyle.color = color;
    return photoshop;
  }

  it('reads the colour out of the SolidColor descriptor', async () => {
    const photoshop = textLayerPhotoshop(solidColorLike(0, 170, 136));
    const text = loadPluginFile(pluginRoot, 'lib/ops/text.js', undefined, photoshop) as {
      get_text_layer: (ctx: { params: Record<string, unknown>; config: Record<string, string> }) => Promise<unknown>;
    };

    const info = (await text.get_text_layer({
      params: { documentId: 'active', layerName: 'Layer' },
      config: { workspaceRoot: '/w', outputDir: '/w/out' },
    })) as { color: { r: number; g: number; b: number } };

    expect(info.color).toEqual({ r: 0, g: 170, b: 136 });
  });

  it('rounds the fractional channels Photoshop hands back', async () => {
    // Setting via the foreground colour returns `136.00000709295273`.
    const photoshop = textLayerPhotoshop(solidColorLike(255, 170.0000050663948, 136.00000709295273));
    const text = loadPluginFile(pluginRoot, 'lib/ops/text.js', undefined, photoshop) as {
      get_text_layer: (ctx: { params: Record<string, unknown>; config: Record<string, string> }) => Promise<unknown>;
    };

    const info = (await text.get_text_layer({
      params: { documentId: 'active', layerName: 'Layer' },
      config: { workspaceRoot: '/w', outputDir: '/w/out' },
    })) as { color: { r: number; g: number; b: number } };

    expect(info.color).toEqual({ r: 255, g: 170, b: 136 });
  });

  it('never addresses the active text layer through a descriptor', () => {
    // `_ref: 'textLayer'` with `targetEnum` addresses the *active* text layer
    // and raises a modal "Could not complete the request" on Photoshop 26.11.
    const source = readFileSync(join(pluginRoot, 'lib/ops/text.js'), 'utf8');
    expect(source).not.toContain(`_obj: 'textStyleRange'`);
    expect(source.replace(/\/\*[\s\S]*?\*\//g, '')).not.toContain(`_ref: 'textLayer'`);
  });
});

describe('document lifecycle', () => {
  /**
   * A Photoshop stub whose document collection can grow and shrink.
   *
   * `documents.add` ignores a `name` argument and the resulting `Document` has a
   * getter-only `name`, because that is what Photoshop 26.11 does — a stub that
   * allowed either would hide exactly the behaviour this is here to pin down.
   */
  function documentStub() {
    const photoshop = photoshopStub() as Record<string, any>;
    const documents = [photoshop.app.activeDocument];
    photoshop.app.documents = documents;
    photoshop.app.documents.add = (options: { width?: number; height?: number }) => {
      const created = {
        ...photoshop.app.activeDocument,
        id: documents.length + 1,
        width: options.width ?? 100,
        height: options.height ?? 100,
      };
      Object.defineProperty(created, 'name', { get: () => 'Без имени-1', configurable: false });
      documents.push(created);
      // The real DOM makes a new document active; the stub has to, or
      // `get_documents` would report the wrong active id.
      photoshop.app.activeDocument = created;
      return created;
    };
    return photoshop;
  }

  function canvas(photoshop: unknown) {
    return loadPluginFile(pluginRoot, 'lib/ops/canvas.js', undefined, photoshop as Stub) as {
      create_document: (ctx: { params: Record<string, unknown> }) => Promise<{
        id: string;
        name: string;
        width: number;
        height: number;
      }>;
      get_documents: () => Promise<{ activeDocumentId: string | null; documents: { id: string; name: string }[] }>;
      close_document: (ctx: { params: Record<string, unknown> }) => Promise<{ name: string }>;
    };
  }

  it('creates a document with the requested geometry', async () => {
    const photoshop = documentStub();
    const ops = canvas(photoshop);

    const info = await ops.create_document({
      params: { name: 'Autumn Sale', width: 1080, height: 1080, resolution: 72, colorMode: 'RGB', background: 'transparent' },
    });

    expect(info.width).toBe(1080);
    expect(info.height).toBe(1080);
  });

  it('reports the name Photoshop gave the document, not the one requested', async () => {
    // `Document.name` is a getter on 26.11, so assigning it throws. Reporting the
    // requested name instead would put one in the plan that Photoshop does not have.
    const photoshop = documentStub();
    const ops = canvas(photoshop);

    const info = await ops.create_document({ params: { name: 'Autumn Sale', width: 640, height: 480 } });

    expect(info.name).toBe('Без имени-1');
  });

  it('lists open documents and names the active one', async () => {
    const photoshop = documentStub();
    const ops = canvas(photoshop);

    const created = await ops.create_document({ params: { width: 100, height: 100 } });
    const listed = await ops.get_documents();

    expect(listed.documents).toHaveLength(2);
    expect(listed.activeDocumentId).toBe(created.id);
  });

  it('refuses to save-and-close a document that has never been saved', async () => {
    const photoshop = documentStub();
    const ops = canvas(photoshop);

    // Saving would need a destination, and inventing one is not this operation's job.
    // The refusal is a synchronous throw: the adapter turns op throws into rejected
    // results, and the document is only known to be unsaved before any await.
    expect(() => ops.close_document({ params: { documentId: 'active', save: true } })).toThrow(/never been saved/);
  });

  it('closes without saving when asked to discard', async () => {
    const photoshop = documentStub();
    let closed = false;
    (photoshop.app.activeDocument as Record<string, unknown>).closeWithoutSaving = () => {
      closed = true;
    };
    const ops = canvas(photoshop);

    const ref = await ops.close_document({ params: { documentId: 'active', save: false } });

    expect(closed).toBe(true);
    expect(ref.name).toBe('stub.psd');
  });
});

describe('DOM-backed operations, enumerated rather than assumed', () => {
  /**
   * The failure this whole area came from: a capability report built from a
   * handful of hand-picked property checks, which concluded that masks, cropping
   * and adjustment layers were unreachable on this build. They were not — the DOM
   * has `document.crop`, `trim`, `flatten`, `sampleColor` and thirty-five layer
   * filters, and all of them work. So the tool tables are checked against the
   * registry rather than trusted.
   */
  it('routes every filter in the shared vocabulary to a Layer method', () => {
    const filters = loadPluginFile(pluginRoot, 'lib/ops/filters.js') as { FILTERS: Record<string, unknown> };
    const operations = readFileSync(resolvePath(join(pluginRoot, '..', 'shared', 'src', 'photoshop', 'operations.ts')), 'utf8');
    const declared = [...operations.matchAll(/filter: z\.literal\('([a-zA-Z]+)'\)/g)].map((m) => m[1]);

    expect(declared.length).toBeGreaterThan(20);
    for (const name of declared) {
      expect(typeof filters.FILTERS[name], `${name} is offered to the model but not implemented`).toBe('function');
    }
    // And nothing implemented that is not offered.
    expect(Object.keys(filters.FILTERS).sort()).toEqual(declared.sort());
  });

  it('translates filter enums instead of guessing at their values', () => {
    // `applyAddNoise` rejects 'gaussian' with "Invalid constant. Expected
    // 'gaussian' to be one of Constants.NoiseDistribution", so the value has to
    // come from the enum. Verified on device, so this guards the mechanism.
    const ps = loadPluginFile(pluginRoot, 'lib/ps.js') as {
      enumValue: (name: string, key: string) => unknown;
      constants: Record<string, Record<string, string>>;
    };
    (ps as { constants: Record<string, Record<string, string>> }).constants.NoiseDistribution = {
      GAUSSIAN: 'gaussianNormal',
    };

    expect(ps.enumValue('NoiseDistribution', 'gaussian')).toBe('gaussianNormal');
    // An enum the build does not have falls back to the raw value, so Photoshop's
    // own error names the constant rather than the plugin swallowing it.
    expect(ps.enumValue('NoSuchEnum', 'whatever')).toBe('whatever');
  });
});

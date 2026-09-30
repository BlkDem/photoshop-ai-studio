import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TOOL_NAME_LIST } from '@photoshop-ai-studio/shared';
import { LogBus, createLogger } from '@photoshop-ai-studio/shared/node';
import { MockPhotoshopAdapter } from '../src/adapter/mock-adapter.js';
import { createHttpApp } from '../src/http.js';
import { Workspace } from '../src/workspace.js';

/**
 * MCP surface tests (brief §28).
 *
 * These drive a **real** MCP client over **real** Streamable HTTP against the
 * real server, so what is under test is the wire contract an LLM would see —
 * not an internal function. Covers tool schemas, validation, structured results
 * and error handling.
 */

let workspaceDir: string;
let workspace: Workspace;
let adapter: MockPhotoshopAdapter;
let server: Server;
let client: Client;
let baseUrl: string;

beforeAll(async () => {
  workspaceDir = mkdtempSync(join(tmpdir(), 'studio-mcp-'));
  workspace = new Workspace(workspaceDir, join(workspaceDir, 'out'));
  adapter = new MockPhotoshopAdapter({ workspace });

  const bus = new LogBus();
  const logger = createLogger({ source: 'mcp', level: 'info', bus, console: false });
  const { app } = createHttpApp({
    adapter,
    logger,
    bus,
    allowedHosts: [],
    allowedOrigins: [],
  });

  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;

  client = new Client({ name: 'test', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
});

afterAll(async () => {
  await client?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  rmSync(workspaceDir, { recursive: true, force: true });
});

interface ToolResult {
  isError?: boolean;
  structuredContent?: { success?: boolean; data?: unknown; error?: { code: string; message: string; recoverable: boolean } };
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

function expectOk(result: ToolResult): unknown {
  expect(result.isError).toBeFalsy();
  expect(result.structuredContent?.success).toBe(true);
  return result.structuredContent?.data;
}

function expectFail(result: ToolResult, code?: string): { code: string; message: string; recoverable: boolean } {
  expect(result.isError).toBe(true);
  expect(result.structuredContent?.success).toBe(false);
  const error = result.structuredContent?.error;
  expect(error).toBeDefined();
  expect(typeof error!.message).toBe('string');
  if (code) expect(error!.code).toBe(code);
  return error!;
}

// ---------------------------------------------------------------------------

describe('tools/list', () => {
  it('advertises every registered tool', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...TOOL_NAME_LIST].sort());
  });

  it('gives every tool a JSON Schema object input', async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.inputSchema, tool.name).toBeDefined();
      expect(tool.inputSchema.type, tool.name).toBe('object');
      expect(tool.description, tool.name).toBeTruthy();
    }
  });

  it('keeps field descriptions in the generated schema (needed by the planner)', async () => {
    const { tools } = await client.listTools();
    const move = tools.find((t) => t.name === 'photoshop.move_layer');
    const properties = move!.inputSchema.properties as Record<string, { description?: string }>;
    expect(properties.x?.description).toContain('Absolute left edge');
    expect(properties.dx?.description).toContain('Relative horizontal');
  });

  it('declares read-only and destructive annotations', async () => {
    const { tools } = await client.listTools();
    const read = tools.find((t) => t.name === 'photoshop.get_document')!;
    const destructive = tools.find((t) => t.name === 'photoshop.delete_layer')!;
    expect(read.annotations?.readOnlyHint).toBe(true);
    expect(destructive.annotations?.readOnlyHint).toBe(false);
    expect(destructive.annotations?.destructiveHint).toBe(true);
  });

  it('marks confirmation-worthy tools in _meta for the Studio', async () => {
    const { tools } = await client.listTools();
    const save = tools.find((t) => t.name === 'photoshop.save_psd')!;
    expect(save._meta?.['studio/requiresConfirmation']).toBe(true);
    expect(save._meta?.['studio/category']).toBe('export');
  });

  it('rejects GET/DELETE because the server is stateless', async () => {
    const response = await fetch(`${baseUrl}/mcp`, { method: 'GET' });
    expect(response.status).toBe(405);
  });
});

describe('tools/call — success', () => {
  it('returns a structured document state', async () => {
    const data = expectOk(await call('photoshop.get_document')) as Record<string, unknown>;
    expect(data).toMatchObject({ name: 'banner.psd', width: 1920, height: 1080, colorMode: 'RGB' });
    expect(Array.isArray(data.layers)).toBe(true);
    expect((data.layers as unknown[]).length).toBe(5);
  });

  it('returns the metadata-only shape from get_document_info', async () => {
    const data = expectOk(await call('photoshop.get_document_info')) as Record<string, unknown>;
    expect(data.layers).toBeUndefined();
    expect(data.layerCount).toBe(5);
  });

  it('applies schema defaults', async () => {
    const data = expectOk(await call('photoshop.create_text_layer', { text: 'Defaults' })) as Record<string, unknown>;
    expect(data.fontSize).toBe(24);
    expect(data.color).toEqual({ r: 0, g: 0, b: 0 });
  });

  it('normalises a hex colour into {r,g,b}', async () => {
    const data = expectOk(
      await call('photoshop.create_text_layer', { text: 'Orange', color: '#FF8800' }),
    ) as Record<string, unknown>;
    expect(data.color).toEqual({ r: 255, g: 136, b: 0 });
  });

  it('mutates the document and reports the new state', async () => {
    expectOk(await call('photoshop.rename_layer', { layerName: 'Logo', name: 'Company Logo' }));
    const data = expectOk(await call('photoshop.get_layer', { layerName: 'Company Logo' })) as Record<string, unknown>;
    expect(data.name).toBe('Company Logo');
  });

  it('supports the layer hierarchy', async () => {
    const group = expectOk(await call('photoshop.create_group', { name: 'Header' })) as Record<string, unknown>;
    expectOk(await call('photoshop.move_layer_to_group', { layer: { layerName: 'Title' }, group: { layerId: group.id } }));
    const layers = expectOk(await call('photoshop.get_layers')) as Record<string, unknown>[];
    const title = layers.find((l) => l.name === 'Title');
    expect(title?.parentId).toBe(group.id);
  });

  it('exports a real PNG inside the workspace', async () => {
    const data = expectOk(await call('photoshop.export_png', { path: 'out/test.png' })) as Record<string, unknown>;
    expect(String(data.path).startsWith(workspaceDir)).toBe(true);
    expect(data.format).toBe('png');
  });

  it('returns a preview payload the Studio can render', async () => {
    const data = expectOk(await call('photoshop.render_preview', { maxWidth: 120 })) as Record<string, unknown>;
    expect(data.mimeType).toBe('image/png');
    expect(data.base64).toMatch(/^iVBOR/);
    expect(data.width).toBe(120);
  });
});

describe('tools/call — errors', () => {
  it('reports a missing layer as recoverable', async () => {
    const error = expectFail(await call('photoshop.get_layer', { layerName: 'Nope' }), 'LAYER_NOT_FOUND');
    expect(error.recoverable).toBe(true);
    expect(error.message).toContain('Nope');
  });

  it('reports an ambiguous layer name with the candidate ids', async () => {
    expectOk(await call('photoshop.create_layer', { name: 'Title' }));
    const error = expectFail(await call('photoshop.get_layer', { layerName: 'Title' }), 'INVALID_PARAMS');
    expect(error.message).toContain('ambiguous');
  });

  it('rejects a layer selector with both id and name', async () => {
    expectFail(await call('photoshop.get_layer', { layerId: 1, layerName: 'Background' }), 'INVALID_PARAMS');
  });

  it('rejects an out-of-range value before touching Photoshop', async () => {
    // The MCP SDK validates arguments against the tool's JSON Schema before the
    // handler runs, so this arrives as a JSON-RPC -32602 rather than our
    // structured envelope. Still an error, still an `isError` result.
    const result = await call('photoshop.set_layer_opacity', { layerName: 'Title', opacity: 500 });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('-32602');
  });

  it('refuses a path outside the workspace', async () => {
    const error = expectFail(await call('photoshop.export_png', { path: '../../etc/passwd' }), 'PATH_NOT_ALLOWED');
    expect(error.recoverable).toBe(false);
    expect(error.message).toContain('outside the configured workspace');
  });

  it('refuses an absolute path outside the workspace', async () => {
    expectFail(await call('photoshop.place_image', { path: '/etc/passwd' }));
  });

  it('refuses to clobber an existing file without overwrite', async () => {
    expectOk(await call('photoshop.export_png', { path: 'out/once.png' }));
    const error = expectFail(await call('photoshop.export_png', { path: 'out/once.png' }), 'FILE_EXISTS');
    expect(error.recoverable).toBe(true);
    expectOk(await call('photoshop.export_png', { path: 'out/once.png', overwrite: true }));
  });

  it('rejects an unsupported extension for the requested format', async () => {
    expectFail(await call('photoshop.export_png', { path: 'out/report.pdf' }), 'UNSUPPORTED_FORMAT');
    expectFail(await call('photoshop.save_psd', { path: 'out/a.png' }), 'UNSUPPORTED_FORMAT');
  });

  it('rejects a crop rectangle outside the canvas', async () => {
    expectFail(await call('photoshop.crop_document', { x: 0, y: 0, width: 9999, height: 10 }), 'INVALID_PARAMS');
  });

  it('surfaces a locked layer', async () => {
    const layers = expectOk(await call('photoshop.get_layers')) as Record<string, unknown>[];
    const background = layers.find((l) => l.name === 'Background')!;
    // The mock has no lock control; force it through the adapter to test the path.
    (adapter as unknown as { documents: Map<string, { layers: Record<string, unknown>[] }> }).documents.forEach((doc) => {
      const layer = doc.layers.find((l) => l.id === background.id);
      if (layer) layer.isLocked = true;
    });
    const error = expectFail(await call('photoshop.rename_layer', { layerId: background.id, name: 'X' }), 'LAYER_LOCKED');
    expect(error.recoverable).toBe(false);
    (adapter as unknown as { documents: Map<string, { layers: Record<string, unknown>[] }> }).documents.forEach((doc) => {
      const layer = doc.layers.find((l) => l.id === background.id);
      if (layer) layer.isLocked = false;
    });
  });

  it('has no escape-hatch tool', async () => {
    const result = await call('photoshop.execute_anything', {});
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/not found/i);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain('photoshop.batch_play');
  });
});

describe('bridge protocol', () => {
  it('publishes structured logs on /events', async () => {
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/events`, { signal: controller.signal });
    expect(response.headers.get('content-type')).toContain('application/x-ndjson');
    expectOk(await call('photoshop.get_document_info'));
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const deadline = Date.now() + 4000;
    let found = false;
    while (!found && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      found = buffer.split('\n').some((line) => line.includes('photoshop.get_document_info'));
    }
    controller.abort();
    expect(found).toBe(true);
  });

  it('rejects an unexpected Host header when hosts are pinned', async () => {
    const { app } = createHttpApp({
      adapter,
      logger: createLogger({ source: 'mcp', level: 'info', console: false }),
      bus: new LogBus(),
      allowedHosts: ['good.example:1234'],
      allowedOrigins: [],
    });
    const pinned = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = (pinned.address() as AddressInfo).port;

    // `fetch` forbids overriding `Host`, so the raw client is used here.
    const withHost = (host: string): Promise<number> =>
      new Promise((resolve, reject) => {
        const request = httpRequest(
          { host: '127.0.0.1', port, path: '/health', method: 'GET', headers: { host } },
          (response) => {
            response.resume();
            resolve(response.statusCode ?? 0);
          },
        );
        request.on('error', reject);
        request.end();
      });

    expect(await withHost('good.example:1234')).toBe(200);
    expect(await withHost('evil.example')).toBe(421);
    await new Promise<void>((resolve) => pinned.close(() => resolve()));
  });
});

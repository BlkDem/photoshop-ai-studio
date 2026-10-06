/**
 * One stroke, several spacings, on a real canvas.
 *
 * Built to settle one question: are the visible rings in a painted stroke the
 * *tip's* concentric fills, or the scalloped edge of overlapping stamps? If it is
 * the stamps, then lowering `outerAlpha` cannot help and tightening `spacing` can,
 * and the expensive fix (a radial-gradient fill per stamp) is not the only option.
 *
 *   node scripts/spacing-test.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { writeFileSync } from 'node:fs';

const client = new Client({ name: 'spacing-test', version: '0.1.0' });
await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3001/mcp')), { timeout: 900_000 });

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 900_000 });
  const p = JSON.parse(r.content?.map((c) => c.text ?? '').join('') ?? '{}');
  const d = p && 'success' in p && 'data' in p ? (p.success === false ? { error: p.error } : p.data ?? {}) : p;
  return d;
};

await call('photoshop.create_document', { name: 'spacing', width: 960, height: 540, resolution: 72, colorMode: 'RGB', background: 'white' });

const SPACINGS = [0.3, 0.12, 0.05, 0.02];
for (const [i, spacing] of SPACINGS.entries()) {
  const y = 80 + i * 110;
  const started = Date.now();
  const r = await call('photoshop.paint_stroke', {
    documentId: 'active',
    points: [{ x: 60, y }, { x: 500, y }, { x: 900, y: y + 20 }],
    brushSize: 90,
    color: '#2f4f6f',
    opacity: 70,
    spacing,
    // The softest tip in the catalog: if the rings survive this, they cannot be
    // coming from the tip.
    tip: { core: 0.18, steps: 7, outerAlpha: 0.03 },
    newLayer: true,
    layerName: `spacing ${spacing}`,
  });
  console.log(`spacing ${spacing}: ok=${r.success} fills=${r.fills ?? '?'} ${Date.now() - started}ms`);
}

const preview = await call('photoshop.render_preview', { documentId: 'active', maxWidth: 960 });
if (preview?.base64) {
  writeFileSync('workspace/spacing-test.png', Buffer.from(preview.base64, 'base64'));
  console.log('wrote workspace/spacing-test.png');
} else console.log('no preview:', JSON.stringify(preview).slice(0, 200));
await client.close();

/**
 * Pulls the active document's render and judges it, without painting anything.
 *
 * Split out from paint-in-photoshop.mjs because a painting takes minutes of fills
 * and a judgement takes a second: re-measuring after a recipe change must not mean
 * re-painting to find out what the last one looked like.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { writeFileSync } from 'node:fs';
import { direct, critiquePng, formatCritique } from '../paint-engine/dist/index.js';

const MCP_URL = process.env.MCP_URL ?? 'http://127.0.0.1:3001/mcp';
const CANVAS = { width: 960, height: 540 };

const client = new Client({ name: 'preview-and-judge', version: '0.1.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL)), { timeout: 600_000 });

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
  const t = r.content?.map((c) => c.text ?? '').join('') ?? '';
  const p = JSON.parse(t);
  return p && 'success' in p && 'data' in p ? (p.success === false ? { error: p.error } : p.data ?? {}) : p;
};

const request = process.argv[2] ?? 'stormy seascape with a ship and breaking waves, moonlight';
const out = process.argv[3] ?? 'workspace/photoshop-real.png';
const { plan } = direct(request, { seed: 20261005, canvas: CANVAS });

const preview = await call('photoshop.render_preview', { documentId: 'active', maxWidth: CANVAS.width });
if (!preview?.base64) {
  console.log('no preview:', JSON.stringify(preview).slice(0, 300));
  await client.close();
  process.exitCode = 3;
} else {
  const png = Buffer.from(preview.base64, 'base64');
  writeFileSync(out, png);
  console.log(`${out}: ${png.length} bytes`);
  const judged = critiquePng(plan, png, { label: 'photoshop' });
  console.log(judged.critique ? formatCritique(judged.critique, 'photoshop') : `unreadable: ${judged.unreadable}`);
}
await client.close();

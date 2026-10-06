/**
 * Paints two layers — sky and water — and stops.
 *
 * The single most useful thing found while building the painting engine: a full
 * `paint-in-photoshop.mjs` run takes around twenty-five minutes at a workable canvas,
 * which is far too slow to look at output after every change. This paints the two
 * layers that carry the value structure and skips everything else, which is about
 * thirteen, and changing what it paints is one line.
 *
 * It answers one question per run: did the marks change shape? Two failures were found
 * this way that a full render would have shown at the same speed but half as often —
 * the stacked-band seams and the wave capsules.
 *
 *   node scripts/field-test.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { direct, PaintEngine, strokeToPixels } from '../paint-engine/dist/index.js';
import { writeFileSync } from 'node:fs';
const client = new Client({ name: 'field-test', version: '0.1.0' });
await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3001/mcp')), { timeout: 900000 });
const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 900000 });
  const p = JSON.parse(r.content?.map((c) => c.text ?? '').join('') ?? '{}');
  return p && 'success' in p && 'data' in p ? (p.success === false ? { error: p.error } : p.data ?? {}) : p; };
const W = Number(process.env.FIELD_WIDTH ?? 700);
const H = Number(process.env.FIELD_HEIGHT ?? 400);
const { plan } = direct('stormy seascape with a ship and breaking waves, moonlight', { seed: 20261005, canvas: { width: W, height: H } });
const engine = new PaintEngine();
await call('photoshop.create_document', { name: 'fields', width: W, height: H, resolution: 72, colorMode: 'RGB', background: 'white' });
let first = true;
for (const stage of plan.stages) {
  // Which layers to paint. Defaults to the two that carry the value structure; the
  // formal elements can be checked on their own, which is a quarter of the time.
  const wanted = (process.env.FIELD_STAGES ?? 'sky,water').split(',').map((s) => s.trim());
  if (!wanted.includes(stage.id)) continue;
  const strokes = [];
  for (const s of engine.strokesForStage(plan, stage)) { const p = strokeToPixels(s, plan.canvas); if (p) strokes.push(p); }
  const t0 = Date.now();
  const r = await call('photoshop.paint_strokes', { documentId: 'active', newLayer: first, layerName: stage.id, strokes: strokes.map((s) => ({
    points: s.points, brushSize: s.size, color: s.color, opacity: Math.round(s.opacity * 100), spacing: s.spacing,
    tip: { core: s.tip.core, steps: s.tip.steps, outerAlpha: s.tip.outerAlpha } })) });
  first = false;
  console.log(`${stage.id}: ${r.success} ${Date.now() - t0}ms ${r.failures?.length ?? 0} failed`);
}
const pv = await call('photoshop.render_preview', { documentId: 'active', maxWidth: W });
if (pv?.base64) { writeFileSync(process.env.FIELD_OUT ?? 'workspace/field-test.png', Buffer.from(pv.base64, 'base64')); console.log('wrote workspace/field-test.png'); }
await client.close();

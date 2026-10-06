/**
 * Paints an Art Director plan in real Photoshop and judges what comes back.
 *
 * Everything so far has been judged on the mock preview, which is this project's own
 * renderer — convenient, deterministic, and not Photoshop. This script closes the
 * loop: it directs a request, compiles the plan into per-layer batches, sends them
 * over MCP to the running Photoshop, pulls a real render back, and runs the critic
 * on *that*.
 *
 * The point is not that the picture looks good. The point is that the critic's
 * numbers are now about Photoshop's output, so the two places the mock and the
 * plugin can disagree — how the synthesized tip composites, and what a `batchPlay`
 * fill actually does to a pixel — become visible as disagreements in the metrics.
 *
 *   node scripts/paint-in-photoshop.mjs "<request>" [out.png]
 *
 * Requires the MCP server on 127.0.0.1:3001 and Photoshop running with the plugin
 * installed and connected. Falls back to reporting that it is not connected rather
 * than pretending a mock answer came from Photoshop.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { direct, PaintEngine, strokeToPixels, critiquePng, formatCritique } from '../paint-engine/dist/index.js';

const MCP_URL = process.env.MCP_URL ?? 'http://127.0.0.1:3001/mcp';
/**
 * Canvas size, overridable because fill cost scales with it and a tight spacing
 * multiplies fills again: the full 960x540 painting at spacing 0.06 runs for hours.
 * A half-size render answers the same question about edge quality in minutes.
 */
const CANVAS = {
  width: Number(process.env.PAINT_WIDTH ?? 960),
  height: Number(process.env.PAINT_HEIGHT ?? 540),
};

async function connect() {
  const client = new Client({ name: 'paint-in-photoshop', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
  await client.connect(transport, { timeout: 1_800_000 });
  return client;
}

const call = async (client, name, args) => {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 1_800_000 });
  const text = result.content?.map((c) => c.text ?? '').join('') ?? '';
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { raw: text };
  }
  // Tools answer `{success, data}`. Unwrapped here rather than at each call site,
  // because a script that reads `.base64` off the wrong level gets an empty string
  // and a "no preview came back" that looks like a Photoshop problem.
  if (parsed && typeof parsed === 'object' && 'success' in parsed && 'data' in parsed) {
    if (parsed.success === false) return { error: parsed.error ?? parsed };
    return parsed.data ?? {};
  }
  return parsed;
};

function pixelsForLayer(plan, layer) {
  const engine = new PaintEngine();
  const strokes = [];
  for (const stage of plan.stages) {
    if (stage.layer !== layer) continue;
    for (const semantic of engine.strokesForStage(plan, stage)) {
      const pixel = strokeToPixels(semantic, plan.canvas);
      if (pixel) strokes.push(pixel);
    }
  }
  return strokes;
}

const toParams = (strokes) =>
  strokes.map((s) => ({
    points: s.points,
    brushSize: s.size,
    color: s.color,
    opacity: Math.round(s.opacity * 100),
    spacing: s.spacing,
    // Forwarded, not defaulted: dropping the tip turns every soft brush into a flat
    // disc, and then the critic measures Photoshop's output for a plan Photoshop was
    // never asked to execute.
    tip: { core: s.tip.core, steps: s.tip.steps, outerAlpha: s.tip.outerAlpha },
    ...(s.blendMode ? { blendMode: s.blendMode } : {}),
  }));

async function main() {
  const request = process.argv[2] ?? 'stormy seascape with a ship and breaking waves, moonlight';
  const out = process.argv[3] ?? 'workspace/photoshop-real.png';

  const client = await connect();

  // Confirm the plugin is actually attached before spending minutes of fills.
  const health = await call(client, 'photoshop.get_documents', {});
  const connected = health?.pluginConnected ?? health?.bridge?.pluginConnected ?? health?.status?.pluginConnected;
  console.log(
    `documents: ${health?.documents?.length ?? '?'}  ` +
      `plugin: ${connected === false ? 'NOT CONNECTED' : connected === true ? 'connected' : 'unknown'}`,
  );
  if (connected === false) {
    console.log('Photoshop is not attached. Open the document and check the plugin log.');
    await client.close();
    process.exitCode = 2;
    return;
  }

  const { plan, assumptions } = direct(request, { seed: 20261005, canvas: CANVAS });
  console.log(`request: ${request}`);
  for (const a of assumptions) console.log(`  assume: ${a}`);
  console.log(`layers: ${plan.layers.join(' -> ')}`);

  await call(client, 'photoshop.create_document', {
    name: plan.title.slice(0, 40) || 'painting',
    width: CANVAS.width,
    height: CANVAS.height,
    resolution: 72,
    colorMode: 'RGB',
    background: 'white',
  });

  let first = true;
  let fills = 0;
  let failures = 0;

  for (const layer of plan.layers) {
    const strokes = pixelsForLayer(plan, layer);
    if (strokes.length === 0) {
      console.log(`  ${layer}: no strokes, skipped`);
      continue;
    }
    const started = Date.now();
    const result = await call(client, 'photoshop.paint_strokes', {
      documentId: 'active',
      newLayer: first,
      layerName: layer,
      strokes: toParams(strokes),
    });
    first = false;
    const painted = result?.success ?? result?.painted ?? strokes.length;
    fills += result?.fills ?? 0;
    failures += result?.failures?.length ?? 0;
    const ms = Date.now() - started;
    console.log(
      `  ${layer}: ${painted}/${strokes.length} strokes, ${result?.fills ?? '?'} fills, ${ms} ms` +
        (result?.failures?.length ? `, ${result.failures.length} FAILED` : '') +
        (result?.layerId !== undefined ? ` -> #${result.layerId}` : ''),
    );
    if (result?.failures?.length) {
      for (const f of result.failures.slice(0, 3)) console.log(`     ! ${JSON.stringify(f)}`);
    }
  }

  const preview = await call(client, 'photoshop.render_preview', { documentId: 'active', maxWidth: CANVAS.width });
  if (!preview?.base64) {
    console.log('no preview came back:', JSON.stringify(preview).slice(0, 200));
    await client.close();
    process.exitCode = 3;
    return;
  }
  const png = Buffer.from(preview.base64, 'base64');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, png);
  console.log(`\nwrote ${out} (${png.length} bytes), ${fills} fills, ${failures} failures`);

  // The critic, now reading Photoshop's pixels rather than the mock's.
  const judged = critiquePng(plan, png, { label: 'photoshop' });
  console.log(judged.critique ? formatCritique(judged.critique, 'photoshop') : `unreadable: ${judged.unreadable}`);

  await client.close();
}

void main();
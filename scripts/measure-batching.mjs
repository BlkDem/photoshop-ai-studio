/**
 * Measures what batching actually buys, with the measuring harness held constant.
 *
 * The naive version of this test runs `probe-mcp.mjs` once per call, which spawns a
 * Node process each time and charges every "separate" iteration ~400ms of
 * interpreter startup. That flatters batching enormously — it measured 4.9x on a
 * workload where the real difference was 7%. Both sides below run in one process,
 * through the same MCP client, so the only variable is the number of calls.
 *
 *   node scripts/measure-batching.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readFile } from 'node:fs/promises';

const MCP_URL = process.env.MCP_URL ?? 'http://127.0.0.1:3001/mcp';

async function connect() {
  const client = new Client({ name: 'measure-batching', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
  // The SDK defaults to 60s, and forty separate `paint_stroke` calls take longer
  // than that on this host — the measurement has to outlast the thing it measures.
  transport.requestInit = { headers: {} };
  await client.connect(transport, { timeout: 900_000 });
  return client;
}

const call = async (client, name, args) => {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 900_000 });
  const text = result.content?.map((c) => c.text ?? '').join('') ?? '';
  return text;
};

async function main() {
  const client = await connect();
  const batch = JSON.parse(await readFile('workspace/args-batch.json', 'utf8'));
  const many = JSON.parse(await readFile('workspace/args-many.json', 'utf8'));
  const create = JSON.parse(await readFile('workspace/args-create.json', 'utf8'));

  async function timed(label, run) {
    await call(client, 'photoshop.create_document', create);
    const start = process.hrtime.bigint();
    await run();
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    console.log(`${label.padEnd(34)} ${ms.toFixed(0).padStart(8)} ms`);
    return ms;
  }

  console.log('— four heavy strokes (~1139 fills) —');
  await timed('4 x paint_stroke', async () => {
    for (let i = 0; i < batch.strokes.length; i += 1) {
      await call(client, 'photoshop.paint_stroke', {
        ...batch.strokes[i],
        newLayer: i === 0,
        layerName: batch.layerName,
        documentId: 'active',
      });
    }
  });
  await timed('1 x paint_strokes', () => call(client, 'photoshop.paint_strokes', batch));

  console.log('— 40 single-stamp dabs (fills negligible) —');
  await timed('40 x paint_stroke', async () => {
    for (let i = 0; i < many.strokes.length; i += 1) {
      await call(client, 'photoshop.paint_stroke', {
        ...many.strokes[i],
        newLayer: i === 0,
        layerName: many.layerName,
        documentId: 'active',
      });
    }
  });
  await timed('1 x paint_strokes', () => call(client, 'photoshop.paint_strokes', many));

  await client.close();
}

void main();
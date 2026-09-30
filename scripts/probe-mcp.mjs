/**
 * Interactive MCP prober for manual verification against a real Photoshop.
 *
 *   node scripts/probe-mcp.mjs <tool> '<json-args>'
 *   node scripts/probe-mcp.mjs <tool> --args-file <path>
 *   node scripts/probe-mcp.mjs <tool> --args-stdin
 *   node scripts/probe-mcp.mjs --list
 *   node scripts/probe-mcp.mjs --doc
 *
 * The `--args-file` / `--args-stdin` forms exist because a JSON argument on a
 * command line is not portable: PowerShell 5.1 re-quotes it and the prober dies
 * with a syntax error in an anonymous script, which reads as a broken tool rather
 * than a broken shell. Anything driving this from Windows should use the file
 * form.
 *
 * Uses the same MCP client the Orchestrator uses, so what it prints is what the
 * AI layer would see.
 */
import { readFile } from 'node:fs/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = process.env.MCP_URL ?? 'http://127.0.0.1:3001/mcp';

const client = new Client({ name: 'studio-probe', version: '0.1.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));

const argv = process.argv.slice(2);
const command = argv[0];

/** Resolves the tool arguments from wherever the caller could safely put them. */
async function resolveArguments() {
  const flag = argv[1];
  if (flag === '--args-file') {
    const path = argv[2];
    if (!path) throw new Error('--args-file needs a path');
    return JSON.parse(await readFile(path, 'utf8'));
  }
  if (flag === '--args-stdin') {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8').trim();
    return text ? JSON.parse(text) : {};
  }
  if (flag !== undefined) return JSON.parse(flag);
  return {};
}

async function call(tool, args) {
  const result = await client.callTool({ name: tool, arguments: args ?? {} });
  const payload = result.structuredContent ?? result.content;
  const mark = result.isError ? '✗' : '✓';
  console.log(`${mark} ${tool}`);
  console.log(JSON.stringify(payload, null, 2));
  return result;
}

if (command === '--list') {
  const { tools } = await client.listTools();
  console.log(`${tools.length} tools from ${url}`);
  for (const tool of tools) {
    const props = Object.keys(tool.inputSchema?.properties ?? {});
    console.log(`  ${tool.name.padEnd(34)} ${tool.title}`);
    console.log(`  ${' '.repeat(34)} in: ${props.join(', ') || '(none)'}`);
  }
} else if (command === '--doc') {
  await call('photoshop.get_document', {});
} else if (command) {
  await call(`photoshop.${command}`, await resolveArguments());
} else {
  console.log(
    "usage: probe-mcp.mjs <tool> '<json>'\n" +
      "       probe-mcp.mjs <tool> --args-file <path>\n" +
      '       probe-mcp.mjs <tool> --args-stdin\n' +
      '       probe-mcp.mjs --list | --doc',
  );
}

await client.close();

# Setup

Two paths:

- **[A. Run without Photoshop](#a-run-without-photoshop)** — 5 minutes, no
  licence. Runs the entire pipeline against the in-memory adapter. Start here to
  see the product work.
- **[B. Run against real Photoshop](#b-run-against-real-photoshop)** — adds the
  UXP Developer Tool and a loaded plugin.

---

## Prerequisites

| | Version | Notes |
|---|---|---|
| Node.js | ≥ 20.11 (22 LTS recommended) | `fetch` and `--env-file` are used |
| npm | ≥ 10 | workspaces; the project does not use pnpm |
| Photoshop | 25.0 or newer | 2024 / 2025. Plugin needs Developer Mode enabled. |
| UXP Developer Tool | 2.x | Ships with Creative Cloud; only needed for path B |

No global installs. No `npm link`. No Photoshop plugin signing for local use.

---

## A. Run without Photoshop

This path uses `MOCK_PHOTOSHOP=true`, which swaps the Photoshop adapter for a
real in-memory document. It is not a preview or a stub — the whole pipeline runs,
including verification, diffs and file writes.

```bash
git clone https://github.com/BlkDem/photoshop-ai-studio.git
cd photoshop-ai-studio

npm install
npm run build

cp .env.example .env
```

Edit `.env`:

```dotenv
MOCK_PHOTOSHOP=true
AI_PLANNER_PROVIDER=mock
AI_VISION_PROVIDER=mock
AI_FAST_PROVIDER=mock
```

Start everything:

```bash
npm run dev
```

Open <http://localhost:3000>.

Send the demo request:

```text
Create a square version of this banner.
```

You should see, in order: the plan (13 steps), an `⚠ Confirmation required`
prompt for the PNG export, the diff, and a verification report with every check
green. Try a few more:

| Request | What happens |
|---|---|
| `rename Logo to Company Logo` | JEV fast path, single step, one verification check |
| `hide Background` | JEV fast path |
| `set the Title opacity to 70%` | JEV fast path |
| `export png` | confirmation-gated write into `workspace/out/` |
| `delete layer CTA` | confirmation-gated; refuse it and the run is skipped, not aborted |
| `set opacity to 70%` | no target named → the assistant asks which layer, instead of guessing |
| `make the sky blue` | not expressible with these tools → asks a clarifying question |

The **LOG** tab streams the whole trace: the AI request, the plan, each MCP call,
each Photoshop request/response, the diff, the verification and the timings.

---

## B. Run against real Photoshop

Steps B1–B4 are in addition to everything in section A.

### B1. Stop the mock

```dotenv
MOCK_PHOTOSHOP=false
```

Restart `npm run dev`.

### B2. Enable Developer Mode

1. **Photoshop** → `Edit ▸ Preferences ▸ Plugins` → tick **Enable Developer
   Mode**.
2. Install the **UXP Developer Tool** from Creative Cloud Desktop.

   If UDT asks to enable developer mode itself, approve it (admin). If you need
   to do it manually, create a `settings.json` containing `{ "developer": true }`
   in:

   | OS | Path |
   |---|---|
   | macOS | `/Library/Application Support/Adobe/UXP/Developer/` |
   | Windows | `%CommonProgramFiles%\Adobe\UXP\Developer\` |

### B3. Point the plugin at the workspace

`photoshop-plugin/config.json` ships with placeholder absolute paths. Set both
to real paths on **this machine**:

```jsonc
{
  "bridgeUrl": "ws://localhost:3002/bridge",

  // Must match WORKSPACE_ROOT in .env — both allow-lists must contain a path
  // for it to be usable.
  "workspaceRoot": "/Users/you/photoshop-ai-studio/workspace",

  // Where exports with no explicit path are written.
  "outputDir": "/Users/you/photoshop-ai-studio/workspace/out"
}
```

| OS | `workspaceRoot` |
|---|---|
| macOS / Linux | `/Users/<you>/photoshop-ai-studio/workspace` |
| Windows | `C:/Users/<you>/photoshop-ai-studio/workspace` |

You can also type these into the plugin panel and press **Save config**; it
writes `config.json` back for you.

### B4. Load the plugin

1. Start the MCP server so the bridge is listening:

   ```bash
   npm run dev:mcp
   ```

   You should see:

   ```text
   MCP (Streamable HTTP) listening on http://127.0.0.1:3001/mcp
   UXP bridge listening on ws://localhost:3002/bridge
   ```

2. In the **UXP Developer Tool**: **Add Plugin…** → select
   `photoshop-plugin/manifest.json` → **Load**.

3. Open the panel in Photoshop: **Plugins ▸ Photoshop AI Studio**.

The panel should read:

```text
Photoshop AI Studio
● Connected
ws://localhost:3002/bridge
UXP 7.2.0 · Photoshop 25.x
```

**If it says `○ Connecting…` and then `● Disconnected`:** the plugin could not
reach the bridge. Check, in order:

1. Is `npm run dev:mcp` running and printing the bridge line?
2. Does `bridgeUrl` in `config.json` match `PLUGIN_PORT` in `.env`?
3. Does the Host use `localhost` rather than `127.0.0.1`? (Both are declared in
   the manifest, but `localhost` is the spelling verified to work.)
4. On macOS, ATS may block insecure `ws://`. Put a TLS terminator in front of
   `PLUGIN_PORT` and point `bridgeUrl` at `wss://…` (see
   [architecture.md § Known limitations](architecture.md#known-limitations)).

### B5. Run the demo against a real document

1. Create or open a banner-like document in Photoshop with layers named
   something like `Background`, `Logo`, `Title`, `Subtitle`, `CTA`.
2. Open <http://localhost:3000>. The Layers rail shows the live hierarchy; the
   centre pane shows a real render once the first preview resolves.
3. Send:

   ```text
   Create a square version of this banner.
   ```

4. Approve. The plugin's `executeAsModal` progress entries appear in Photoshop's
   history panel, and the export lands in `workspace/out/`.

---

## Configuration

Everything external is in `.env`. See `.env.example` for the annotated list.

### The ones that matter

| Variable | Default | Effect |
|---|---|---|
| `MOCK_PHOTOSHOP` | `false` | `true` swaps in the in-memory adapter |
| `WORKSPACE_ROOT` | `./workspace` | Filesystem allow-list. Paths outside it are refused. |
| `PHOTOSHOP_OUTPUT_DIR` | `./out` | Default destination for exports |
| `AI_PLANNER_PROVIDER` | `mock` | `openai` · `anthropic` · `openai-compatible` · `mock` |
| `AI_PLANNER_MODEL` | `gpt-4.1` | |
| `AI_PLANNER_API_KEY` | — | Never reaches the browser |
| `AI_MAX_REPAIR_ATTEMPTS` | `2` | Repair-loop budget |
| `JEV_MIN_CONFIDENCE` | `0.82` | Raise it to send more traffic to the model |
| `JEV_RUNTIME_URL` | — | Point at a real JEV runtime instead of the built-in engine |
| `SERVE_STATIC` | `false` | Serve `studio/dist` from the Orchestrator |

### Using a real model

`openai-compatible` covers OpenAI, Groq, OpenRouter, Together, LM Studio, vLLM
and Ollama's `/v1` surface — they speak the same wire format.

```dotenv
# OpenAI
AI_PLANNER_PROVIDER=openai
AI_PLANNER_MODEL=gpt-4.1
AI_PLANNER_API_KEY=sk-...

# A local model via Ollama
AI_PLANNER_PROVIDER=openai-compatible
AI_PLANNER_BASE_URL=http://localhost:11434/v1
AI_PLANNER_MODEL=qwen2.5:14b

# Anthropic
AI_PLANNER_PROVIDER=anthropic
AI_PLANNER_MODEL=claude-sonnet-4-5
AI_PLANNER_API_KEY=sk-ant-...
```

The three roles are independent, so a strong planner with a cheap fast model is
normal:

```dotenv
AI_PLANNER_PROVIDER=openai
AI_PLANNER_MODEL=gpt-4.1
AI_PLANNER_API_KEY=sk-...

AI_FAST_PROVIDER=openai-compatible
AI_FAST_BASE_URL=http://localhost:11434/v1
AI_FAST_MODEL=llama3.2
```

Keep `AI_TEMPERATURE` low (default `0.1`). Plans drive real mutations.

---

## Inspecting MCP directly

```bash
npm run inspector
```

Paste `http://127.0.0.1:3001/mcp` for the direct MCP endpoint, or
`http://localhost:3000/mcp` to go through the Studio dev proxy (same origin, no
CORS). You can browse all 30 tools, read their JSON Schemas and call them by
hand — with `MOCK_PHOTOSHOP=true` that is a complete, safe playground.

From the shell:

```bash
curl -s http://127.0.0.1:3001/health | jq
curl -s http://127.0.0.1:3001/tools  | jq
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Studio shows "orchestrator is not reachable" | Orchestrator not running, or `ORCHESTRATOR_PORT` differs from the Vite proxy target | Start `npm run dev:orchestrator`; check ports agree |
| Plugin never connects | Bridge URL mismatch, or ATS on macOS | See §B4 step 4 |
| `PATH_NOT_ALLOWED` on every export | `workspaceRoot` in `config.json` ≠ `WORKSPACE_ROOT` in `.env` | Both allow-lists must contain the path |
| `FILE_EXISTS` on the second export | Working as designed | Use a different `path`, or `overwrite: true` |
| `NO_DOCUMENT_OPEN` | No document, or a different one is active | Open the document you want to edit |
| `NOT_CONNECTED` mid-run | Plugin reloaded or Photoshop restarted | Recoverable: re-approve, or retry — the repair loop handles it |
| Run says `PLAN_INVALID` | The planner could not express the request | Rephrase, or name the layer explicitly. The assistant message says what it needs. |
| Port already in use | Something else has it | Change the port in `.env`; restart everything |

---

## Uninstalling

```bash
# Stop the servers
# In UXP Developer Tool: select the plugin → Unload
# In Photoshop: close the panel
```

Nothing is written outside `workspace/`, `data/` and the files you saved into
`config.json`. Delete those to leave nothing behind.

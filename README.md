# Photoshop AI Studio

An AI interface for Adobe Photoshop. You tell it what you want changed; it reads
the open document, proposes a plan, you approve it, it executes through MCP, and
then it **checks the resulting document state** rather than trusting that the
call succeeded.

```text
User → Studio → Orchestrator → JEV / LLM → MCP → UXP Plugin → Photoshop
                                  ↓
                            State → Diff → Verification → Repair
```

The last line is the point. `photoshop.move_layer` can report success and leave
the layer somewhere else. This system re-reads the document and proves the
outcome.

---

## Quick start (5 minutes, no Photoshop)

```bash
git clone https://github.com/BlkDem/photoshop-ai-studio.git
cd photoshop-ai-studio

npm install
npm run build

cp .env.example .env
# set MOCK_PHOTOSHOP=true   (the default in .env.example)

npm run dev
```

Open <http://localhost:3000> and send:

```text
Create a square version of this banner.
```

You get a 13-step plan, a confirmation prompt for the export, then a diff and a
verification report with every check green. Try `rename Logo to Company Logo`
next — that one goes through the JEV fast path in ~25 ms with no model call.

Full instructions, including against real Photoshop: **[docs/setup.md](docs/setup.md)**.

---

## What it does

**30 typed MCP tools**, no escape hatches:

| | |
|---|---|
| Document | `get_document` `get_document_info` `duplicate_document` `save_document` |
| Layers | `get_layers` `get_layer` `create_layer` `delete_layer` `rename_layer` `move_layer` `set_layer_visibility` `set_layer_opacity` `create_group` `move_layer_to_group` `reorder_layer` |
| Text | `create_text_layer` `get_text_layer` `update_text_layer` `set_text_position` `set_text_font_size` `set_text_color` |
| Images | `place_image` `resize_layer` |
| Canvas | `resize_canvas` `crop_document` |
| Export | `export_document` `export_png` `export_jpg` `save_psd` |

Full reference: **[docs/mcp-tools.md](docs/mcp-tools.md)**.

**Every tool has** a strict schema, a planner-facing description, a structured
result, and typed errors carrying a `recoverable` flag.

---

## The parts

```text
photoshop-ai-studio/
├── studio/            React UI — chat, plan approval, diff, history, log
├── orchestrator/      planning, safety, execution, diff, verification, repair
├── mcp-server/        MCP tools over Streamable HTTP + the UXP WebSocket bridge
├── photoshop-plugin/  UXP plugin for Photoshop 25+ — plain JS, no build
├── shared/            schemas, error taxonomy, adapter contract, diff maths
└── docs/
```

**The plugin contains no LLM.** It executes validated operations inside
Photoshop's own modal scope and nothing else. `batchPlay` appears in exactly two
places in it — the wrapper that runs descriptors and inspects the result, and the
individual adapter methods — and a test walks the source to keep it that way.

---

## Design commitments

**The model proposes; it never disposes.** It emits a plan. The plan is validated
against the tool registry, shown to the user, approved by the user, and executed
by a fixed executor. There is no path from the model to Photoshop that skips a
stage.

**State is read, not assumed.** A snapshot is taken before planning (so the
model grounds itself in reality, not in a guess) and again after execution (so
verification has something to check).

**Post-conditions are derived, not trusted.** From `rename_layer(layer, name)` the
system knows the post-condition is "that layer's name equals `name`" — it does not
need the model to say so. A planner that forgets to prove its work still gets
checked.

**The model cannot mark a step safe.** `destructive` comes from the tool
registry and is re-checked at execution time, not read from the plan. There is a
test that tampers with the plan to prove it.

**Destructive work asks first.** Deleting a layer, cropping away pixels or
overwriting a file pauses for an explicit per-step confirmation. Refusing one step
skips it rather than aborting the run — a gate that punishes the whole run
teaches people to approve blindly.

**Failures are typed.** Every error carries `recoverable`. Only recoverable ones
enter the repair loop, and a non-recoverable error stops it immediately — a
locked layer will still be locked on the next attempt, and retrying is how you
build an infinite loop.

**The filesystem is an allow-list.** Paths resolve against `WORKSPACE_ROOT`, and
the check runs twice: once in the MCP server, once inside Photoshop. No shell, no
arbitrary JS, no unscoped filesystem.

Rationale for each of these, with the alternatives that were rejected:
**[docs/architecture.md](docs/architecture.md)**.

---

## Working without a licence

`MOCK_PHOTOSHOP=true` swaps the Photoshop adapter for a real in-memory document
model: real validation, real typed errors, real files on disk, a real PNG encoder
for previews and exports. The whole pipeline runs — plan, approval, execution,
diff, verification, repair, history.

That is what makes the tests possible and the demo repeatable. It is selected
only by configuration; there is no code path that silently degrades to it in
production.

---

## Development

```bash
npm test              # 182 tests, ~8s, no Photoshop needed
npm run lint
npm run typecheck
npm run build
npm run dev           # all four processes with watch
```

Requires Node ≥ 20.11. No global installs, no `pnpm`, no `npm link`.

- **[docs/development.md](docs/development.md)** — layout, how to add a tool or a
  provider, how to work on the plugin without a build step.
- **[docs/setup.md](docs/setup.md)** — setup for both paths, configuration,
  troubleshooting.
- **[docs/mcp-tools.md](docs/mcp-tools.md)** — generated tool reference.

---

## Requirements

| | |
|---|---|
| Node.js | ≥ 20.11 (22 LTS recommended) |
| Photoshop | 25.0+ with Developer Mode enabled (only for the real path) |
| UXP Developer Tool | 2.x (only for the real path) |
| Model provider | optional — `AI_PLANNER_PROVIDER=mock` runs a deterministic planner |

---

## Current state

**Verified end to end** on Linux with the mock adapter: all 30 tools, the repair
loop, cancellation, confirmation gating, history persistence, live event
streaming.

**Not yet executed against a real Photoshop build.** The plugin follows the
documented UXP API, is defensive where builds differ (`bounds` shapes, `LayerKind`
enums, `translate`/`scale` fallbacks), and its contract with `shared` is statically
tested — but expect to fix something on the first run in Photoshop. The likely
candidates are annotated with fallbacks in `photoshop-plugin/lib/ps.js`.

`ws://localhost` is verified on Windows; macOS App Transport Security may require
a TLS terminator in front of `PLUGIN_PORT`.

Both caveats, and the other eight known limitations, are listed in
[docs/architecture.md § Known limitations](docs/architecture.md#known-limitations).

---

## License

MIT

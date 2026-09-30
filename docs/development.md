# Development

Working on Photoshop AI Studio: how to run it, how it is put together, and what
to do when you change something.

---

## Commands

```bash
npm install          # once
npm run build        # tsc project references + Studio bundle
npm run dev          # all four processes with watch
npm test             # builds first, then runs vitest
npm run lint         # eslint (flat config)
npm run typecheck    # tsc -b, no emit of JS beyond the build outputs
npm run docs:tools   # regenerate docs/mcp-tools.md from the registry
```

Per-process:

```bash
npm run dev:shared        # tsc -b shared --watch
npm run dev:mcp           # MCP server + UXP bridge
npm run dev:orchestrator  # Orchestrator REST + event stream
npm run dev:studio        # Vite dev server

npm start             # Orchestrator, serving studio/dist (needs SERVE_STATIC=true)
npm run start:mcp     # MCP server only
```

`npm run dev` uses `concurrently`. Run `npm run build` once after `npm install`
so the services have something to import — `tsx` resolves `@photoshop-ai-studio/shared`
through its built `dist`.

### Ports

| Port | Service | Override |
|---|---|---|
| 3000 | Studio (Vite) | `STUDIO_PORT` |
| 3001 | MCP server (`/mcp`) + log stream (`/events`) | `MCP_PORT` |
| 3002 | UXP bridge (WebSocket) | `PLUGIN_PORT` |
| 3003 | Orchestrator (`/api`) | `ORCHESTRATOR_PORT` |

`ORCHESTRATOR_PORT` is not in the original brief. It exists because Studio needs
its own origin and the MCP server already owns one; the Vite dev proxy forwards
`/api` to it.

---

## Repository layout

```text
shared/                  contracts only — zod is its sole dependency
  src/
    errors.ts            error taxonomy + `StudioException`
    bridge.ts            MCP server ↔ UXP plugin protocol
    plan.ts              Plan / Run / confirmation shapes
    history.ts           HistoryRecord
    logging.ts           structured log records
    api.ts               Studio ↔ Orchestrator contract
    node.ts              env loader + logger (kept out of the barrel so the
                         browser bundle never pulls in `node:fs`)
    photoshop/
      document.ts        DocumentInfo, DocumentState
      layer.ts           LayerInfo, selectors, tree helpers
      text.ts            text + colour + resample + anchor enums
      operations.ts      ★ the operation registry
      adapter.ts         PhotoshopAdapter interface
      snapshot.ts        DocumentSnapshot
      diff.ts            diffing + the expectation vocabulary
      expectations.ts    ★ derived post-conditions
      validation.ts      ★ cross-field validation
  test/                  registry, diff, tree, colour

mcp-server/
  src/
    config.ts  index.ts
    server.ts           MCP tool registration (from the registry)
    dispatch.ts         op → adapter method, compile-time checked
    http.ts             stateless Streamable HTTP + NDJSON events
    workspace.ts        filesystem allow-list
    bridge/             WebSocket server + request correlation
    adapter/
      uxp-remote-adapter.ts
      mock-adapter.ts   in-memory Photoshop
  test/mcp.test.ts      real MCP client over real HTTP

orchestrator/
  src/
    orchestrator.ts     ★ the run lifecycle
    config.ts  index.ts
    gateway/            ModelGateway + openai-compatible / anthropic / mock
    jev/                JevRouter + deterministic / remote
    state/verification.ts   VerificationEngine
    execution/          plan-builder, safety, executor, history
    mcp/client.ts       the Orchestrator's MCP client
    http/api.ts         REST + NDJSON event hub
  test/                 jev, state, gateway, full-stack orchestrator

studio/                 React + Vite UI
photoshop-plugin/       plain JS, loaded directly by Photoshop — no build
  manifest.json  config.json  index.html  index.js  styles.css
  lib/{bridge,adapter,ps,errors,logger}.js
  lib/ops/{document… via canvas,layers,text,images}.js
  icons/               generated PNGs
  test/contract.test.ts ★ plugin ↔ shared static contract

docs/                   architecture, setup, mcp-tools, development
scripts/                generate-tool-docs.mjs
```

★ = the files you will change most.

---

## Adding a Photoshop capability

The registry makes this a three-step change.

**1. `shared/src/photoshop/operations.ts`** — one entry:

```ts
my_operation: {
  tool: 'photoshop.my_operation',
  title: 'My Operation',
  description: 'What it does, and when to prefer it. Written for the planner.',
  category: 'layer',
  destructive: false,          // → gates the confirmation flow
  requiresConfirmation: false, // → adds a ⚠ in the Studio plan view
  params: MyParamsSchema,
  result: MyResultSchema,
},
```

Add the op name to `OPERATION_NAMES`.

**2. `shared/src/photoshop/adapter.ts`** — the interface method:

```ts
myOperation(sel: LayerSelector, value: number): Promise<LayerInfo>;
```

**3. Two implementations, both type-checked:**
- `mcp-server/src/adapter/uxp-remote-adapter.ts` — forward to the bridge
- `mcp-server/src/adapter/mock-adapter.ts` — in-memory behaviour
- `mcp-server/src/dispatch.ts` — the mapped type makes this a compile error if
  you forget
- `photoshop-plugin/lib/ops/*.js` — the real implementation

Then **4.** `deriveExpectations` in `shared/src/photoshop/expectations.ts` — what
does "it worked" look like? A tool with no expectation is a tool nobody can prove.

Run `npm test`: `photoshop-plugin/test/contract.test.ts` fails until the plugin
implements it, and `shared/test/operations.test.ts` checks the registry
invariants. Then `npm run docs:tools`.

### Tool-writing rules

- **Description is for the model.** Say what it does, when to prefer it over a
  neighbour, and what the units are. That text is the planner's only guide.
- **Prefer a narrow tool over a generic one.** `set_layer_opacity` beats
  `update_layer({opacity})` — the narrow one cannot be used to change something
  unintended.
- **Mark it destructive if you would not want it done silently.** Deleting a
  layer, cropping away pixels, overwriting a file. Being conservative here costs
  one extra click; being liberal costs someone their artwork.
- **Derive an expectation.** Verification is the product's core claim.

---

## Working on the UXP plugin

No build step. Photoshop loads these files directly, so:

```bash
# 1. start the bridge so the socket exists
npm run dev:mcp

# 2. in the UXP Developer Tool: Add Plugin → photoshop-plugin/manifest.json → Load
# 3. Reload after every change (UDT watches, or ⌘R / the Reload button)
```

Constraints to respect:

- **Plain ES5-ish JavaScript.** `var`, `function`, no optional chaining. It costs
  nothing and it cannot break on a runtime you do not control.
- **No `require` of anything except `photoshop`, `uxp`, and relative paths.** A
  lint rule and a contract test both enforce this.
- **`entrypoints.setup()` must be called synchronously at the top level** of the
  first script. Deferred setup throws an uncatchable error on some builds.
- **Every mutation goes through `core.executeAsModal`.** `ps.asModal` in
  `lib/adapter.js` is the only place that should open one.
- **Every `batchPlay` result must be inspected.** `ps.batchPlay` throws on
  `{_obj: 'error'}`; using it correctly is the difference between a failed edit
  and a reported success.
- **`addEventListener`, never inline `onclick`.** Inline handlers need
  `allowCodeGenerationFromStrings`, which this plugin deliberately does not
  request.
- **Bounds shapes vary by build.** `lib/ps.js` handles both
  `{left, top, right, bottom}` and `{left, top, width, height}`.

Read the UXP reference before touching Photoshop APIs:

- <https://developer.adobe.com/photoshop/uxp/2022/ps_reference/classes/document/>
- <https://developer.adobe.com/photoshop/uxp/2022/ps_reference/media/batchplay/>
- <https://developer.adobe.com/photoshop/uxp/2022/ps_reference/media/executeasmodal/>

---

## Working on the planner

### Prompts

`orchestrator/src/gateway/openai-compatible.ts` builds both prompts and exports
them for testing (`plannerSystemPrompt`, `plannerUserPrompt`,
`renderStateForPrompt`). Anthropic reuses them verbatim — only the wire format
differs, so a prompt change applies to both providers.

`renderStateForPrompt` is worth improving before you touch the system prompt: it
is what the model actually reasons about. A layer tree with parent ids and pixel
bounds beats prose every time.

### Adding a provider

1. Implement `ModelGateway` (`plan`, `analyze`, `verify`) in
   `orchestrator/src/gateway/`.
2. Reuse `parseJsonLoose` and `coercePlanDraft` — models wrap JSON in prose far
   more often than they should, and a hard failure there throws away an
   otherwise good plan.
3. Add a case to `createGateway` and the provider id to `KNOWN_PROVIDERS` in
   `orchestrator/src/config.ts`.
4. Add a test that a missing API key produces a typed, recoverable failure.

No other file changes. If that is not true, the abstraction has leaked.

### Tuning

- `AI_TEMPERATURE` — keep it low (default `0.1`). Plans drive real mutations.
- `JEV_MIN_CONFIDENCE` — raise it to send more traffic to the model; lower it to
  make the fast path more permissive.
- `AI_MAX_PLAN_STEPS` — the backstop against a runaway planner.
- `AI_MAX_REPAIR_ATTEMPTS` — how much of the budget a failure may spend.

---

## Tests

182 tests, no Photoshop required, ~8 seconds.

```bash
npm test
npm test -- --watch
npm test -- orchestrator/test/jev.test.ts
```

What each suite is for:

| Suite | Question it answers |
|---|---|
| `shared/test/operations.test.ts` | Is the registry self-consistent, and do diff/expectation derivation behave? |
| `mcp-server/test/mcp.test.ts` | What does a real MCP client see — schemas, annotations, structured results, errors, Host-header guard? |
| `orchestrator/test/orchestrator.test.ts` | Does the full lifecycle work against a real MCP server: plan → approve → execute → diff → verify → repair → history? |
| `orchestrator/test/state.test.ts` | Does the VerificationEngine catch a lying adapter, and does the safety gate hold? |
| `orchestrator/test/jev.test.ts` | Does the fast path match what it should and abstain from everything else? |
| `orchestrator/test/gateway.test.ts` | Is prompt construction correct, and is JSON tolerance enough? |
| `photoshop-plugin/test/contract.test.ts` | Does the plugin still implement exactly the operations the registry declares? |

Two conventions worth keeping:

- **The orchestrator tests use a real MCP server on a real socket.** Only the
  Photoshop adapter and the model are substituted. A test that mocked the MCP
  client would not catch a schema or transport bug, which is the class of failure
  that layer exists to prevent.
- **Tests that need a failure inject one.** Overriding `adapter.moveLayer` to
  report a position Photoshop never applied is how the "lying tool" test works.
  Reach for that before asserting on internals.

---

## Code conventions

- TypeScript `strict` plus `noUncheckedIndexedAccess`. No `any` (a lint error);
  use `unknown` and narrow.
- ESM everywhere. `verbatimModuleSyntax` means `import type` for type-only
  imports, which the lint rule enforces.
- Node-only helpers live behind `@photoshop-ai-studio/shared/node` so the
  browser bundle never imports `node:fs`.
- Comments explain *why*, not *what*. The interesting decisions in this repo are
  all non-obvious (why the plugin dials out, why verification re-reads state,
  why `batchPlay` results are inspected) — those get comments; `// increment i`
  does not.
- Errors are typed. Throw `StudioException` (services) or `StudioError` (plugin)
  with a code from the taxonomy; never a bare `Error` that crosses a boundary.

---

## Architecture decisions

Read [architecture.md](architecture.md) before changing a boundary. The ADRs
explain why the plugin dials out, why the MCP server is stateless, why there is
no `execute_anything` tool, and why verification re-reads the document.

If you disagree with one, change it there first — an ADR that no longer matches
the code is worse than no ADR.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `Cannot find module '@photoshop-ai-studio/shared'` | Run `npm run build` — the services import `shared/dist` |
| `tsx` resolves nothing after `npm install` | Same; the workspace symlink needs a build |
| Port in use | Change the port in `.env`; restart all processes |
| UXP plugin: `● Disconnected` | See [setup.md §B4](setup.md#b4-load-the-plugin) |
| `PATH_NOT_ALLOWED` | `workspaceRoot` in `config.json` ≠ `WORKSPACE_ROOT` in `.env` |
| Tests fail after editing the registry | Run `npm run docs:tools`; the plugin contract test must be updated to match |
| `error.number == 9` from Photoshop | Another plugin holds the modal scope. Recoverable; retry. |
| Vite proxy 504 on `/api/events` | Orchestrator not running, or a different `ORCHESTRATOR_PORT` |

---

## Known state of the MVP

Honest summary of what is verified and what is not:

- **Verified end to end** on Linux with `MOCK_PHOTOSHOP=true`: the full pipeline,
  all 30 tools, the repair loop, cancellation, confirmation gating, history
  persistence, event streaming, static serving.
- **Not yet executed against a real Photoshop build.** The plugin follows the
  documented API and is defensive where builds differ, and its contract is
  statically tested. Expect to fix something on first run in Photoshop; the
  fallbacks are annotated in `photoshop-plugin/lib/ps.js`.
- **`ws://localhost` on macOS** is unverified; ATS may require a TLS terminator.
  See [architecture.md](architecture.md#known-limitations).

Everything else in this document is either tested or explicitly marked as a
design decision.

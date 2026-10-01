# Architecture

Photoshop AI Studio is five components with one direction of authority. Each
boundary exists because the alternative was to trust an AI with something it
should not be trusted with.

```text
┌──────────┐   REST + NDJSON    ┌───────────────┐   MCP/StreamableHTTP   ┌─────────────┐   WebSocket   ┌────────────┐
│  Studio  │ ─────────────────► │ Orchestrator  │ ────────────────────► │ MCP server  │ ◄───────────► │ UXP plugin  │ ──► Photoshop
│ (browser)│ ◄───────────────── │  (Node)       │ ◄──────────────────── │  (Node)     │   bridge      │  (in PS)    │
└──────────┘   log + run events └───────┬───────┘   structured results   └──────┬──────┘               └────────────┘
                                      │                                        │
                                      ▼                                        ▼
                            Model Gateway                          PhotoshopAdapter
                     (LLM / JEV, provider-agnostic)      (UxpRemoteAdapter | MockPhotoshopAdapter)
```

Authority flows one way. The model proposes; the Orchestrator disposes; only the
adapter touches Photoshop; only the plugin knows Adobe exists.

---

## Table of contents

1. [Component responsibilities](#1-component-responsibilities)
2. [ADR-001 — The plugin dials out to the MCP server](#adr-001--the-plugin-dials-out-to-the-mcp-server)
3. [ADR-002 — JSON envelopes on the bridge, MCP at the layer above](#adr-002--json-envelopes-on-the-bridge-mcp-at-the-layer-above)
4. [ADR-003 — One operation registry drives the whole tool surface](#adr-003--one-operation-registry-drives-the-whole-tool-surface)
5. [ADR-004 — The Orchestrator is an MCP *client*; the browser is not](#adr-004--the-orchestrator-is-an-mcp-client-the-browser-is-not)
6. [ADR-005 — Stateless MCP server](#adr-005--stateless-mcp-server)
7. [ADR-006 — Verification re-reads the document](#adr-006--verification-re-reads-the-document)
8. [ADR-007 — Expectations are derived, not trusted](#adr-007--expectations-are-derived-not-trusted)
9. [ADR-008 — The model cannot mark a step safe](#adr-008--the-model-cannot-mark-a-step-safe)
10. [ADR-009 — JEV abstains rather than guesses](#adr-009--jev-abstains-rather-than-guesses)
11. [ADR-010 — A mock adapter, not a mock Photoshop](#adr-010--a-mock-adapter-not-a-mock-photoshop)
12. [ADR-011 — Writing a value is not the same as applying it](#adr-011--writing-a-value-is-not-the-same-as-applying-it)
13. [ADR-012 — The servers must be restarted, or the evidence lies](#adr-012--the-servers-must-be-restarted-or-the-evidence-lies)
14. [ADR-013 — Five more from the DOM, two of which could not be built](#adr-013--five-more-from-the-dom-two-of-which-could-not-be-built)
12. [Tool surface: why there is no `execute_anything`](#tool-surface-why-there-is-no-execute_anything)
13. [End-to-end walkthrough](#end-to-end-walkthrough)
14. [Security model](#security-model)
15. [Failure modes](#failure-modes)
16. [Adding a creative application](#adding-a-creative-application)
17. [Known limitations](#known-limitations)
18. [Research notes and sources](#research-notes-and-sources)

---

## 1. Component responsibilities

| Component | Owns | Must never |
|---|---|---|
| `studio/` | UI, plan rendering, approval surface, live log tail | Speak MCP, hold a credential, call Photoshop |
| `orchestrator/` | Intent routing, planning, safety gate, execution, diff, verification, repair, history | Know Adobe exists, touch the filesystem outside the workspace |
| `mcp-server/` | Tool schemas, argument validation, path policy, the bridge | Contain business logic or an LLM call |
| `photoshop-plugin/` | The only `batchPlay` and the only `require('photoshop')` | Contain an LLM, business rules, or filesystem policy decisions |
| `shared/` | Schemas, error taxonomy, adapter contract, bridge protocol, diff/expectation maths | Import anything runtime-heavy (`node:fs` lives behind `shared/node`) |

`shared/` is the only place two components agree on anything. The
`PhotoshopAdapter` interface lives there, which is why the MCP server's tools do
not know whether they are talking to Photoshop or to the in-memory mock.

---

## ADR-001 — The plugin dials out to the MCP server

**Decision.** The MCP server hosts a WebSocket server on `PLUGIN_PORT`; the UXP
plugin opens a *client* connection to it.

**Why.** The UXP runtime is a WebSocket client only. Adobe states plainly that
"plugins can connect to WebSocket servers, but cannot host or accept incoming
connections"
([Premiere network recipes](https://developer.adobe.com/premiere-pro/uxp/resources/recipes/network/)). There is no
`net` module in UXP — the only standalone modules are `fs`, `os` and `uxp` — and
running a server from UXP is still an open feature request. So the listening
socket has to live outside Photoshop, and the only workable direction is
outbound.

**Consequences we accepted:**

- Photoshop needs no inbound firewall allowance.
- A Photoshop restart is recovered by the plugin's reconnect loop, not by the user.
- One Photoshop session may be attached at a time; a new connection replaces the
  old one, which matches reality (the stale socket belongs to a dead process).
- `loadEvent: "startup"` is set so the socket comes up without opening the panel.

**The manifest detail that is not documented anywhere.** `requiredPermissions.network.domains`
must list the loopback origins with an explicit scheme and a trailing slash —
`ws://localhost/`, `http://localhost/` — and the plugin must connect to the
hostname `localhost`, not the IP literal. Adobe does not document this; it is the
combination verified to work in practice (and a third-party analysis of the UXP
manifest parser suggests the parser discards IP-literal hosts before permission
matching while accepting `localhost` explicitly). Both spellings are declared
defensively. **If a future Photoshop build rejects the connection**, the symptom
is a `close` with no `hello`, and the plugin panel shows the exact URL it tried.

**Known platform caveat.** macOS App Transport Security restricts insecure HTTP.
`ws://localhost` is verified on Windows; on macOS, be ready to put a TLS
terminating tunnel in front of `PLUGIN_PORT`. This is flagged rather than papered
over because it cannot be tested from a Linux CI box.

---

## ADR-002 — JSON envelopes on the bridge, MCP at the layer above

**Decision.** The bridge carries a deliberately tiny request/response protocol
(`{v, type:'op', id, op, params}` → `{v, type:'op.result', id, result}`). MCP
lives one layer up, in the MCP server.

**Why.** The plugin is plain ES5-ish JavaScript with no bundler and no npm
dependency — it is loaded from a folder by the UXP Developer Tool. It cannot
reasonably speak Streamable HTTP's SSE framing, session negotiation or zod
validation. Meanwhile MCP semantics — tool naming, JSON Schemas, structured
results, typed errors — belong where the tool list is generated and where a
standard client can discover it.

**Result.** `MCP Inspector`, any MCP SDK client and any future agent can talk to
the MCP server. The plugin stays a 12-file, zero-dependency program.

**Both sides agree on:** the protocol version (a mismatch is rejected, not
guessed), the `{ success, data | error }` envelope, and the operation name set
(`photoshop-plugin/test/contract.test.ts` fails the build if the plugin's
dispatch table and `shared`'s registry diverge).

---

## ADR-003 — One operation registry drives the whole tool surface

`shared/src/photoshop/operations.ts` defines, for each of the 30 capabilities:
the MCP tool name, a planner-facing description, the zod input schema, the result
schema, and the `destructive` / `requiresConfirmation` flags.

Everything else is derived:

| Consumer | Derived from the registry |
|---|---|
| MCP server | tool registration, `outputSchema`, `annotations`, `_meta` for the UI |
| Orchestrator | prompt catalogue, destructive-step gating, confirmation questions |
| Studio | the Tools panel, the ⚠ badges in the plan view |
| Tests | the "covers every capability in the brief" list |

Adding a Photoshop capability means one registry entry, one adapter method and
one plugin operation. There is no second place to keep in sync, and the mapped
type `OpDispatcher` makes a missing adapter method a **compile error**, not a
runtime 404.

**Deliberate constraint: no `z.transform()` and no `.refine()` in tool schemas.**
MCP converts tool schemas to JSON Schema for the model. Effect-wrapped fields
(`ZodPipe`, `ZodEffects`) make that conversion lossy, so cross-field rules live
in `shared/src/photoshop/validation.ts` and colour normalisation happens once, in
the tool dispatch. The result is a plain `object` JSON Schema that a model reads
correctly, and identical validation for both adapters.

---

## ADR-004 — The Orchestrator is an MCP *client*; the browser is not

**Decision.** The Studio speaks REST + NDJSON to the Orchestrator. The
Orchestrator is the MCP client.

**Why.** It keeps credentials and provider selection on the server, and it puts
the approval gate in the same process as the executor — the browser cannot
bypass it, because the browser has no execution path at all. It also sidesteps
the two things that make MCP-in-a-browser awkward: CORS header exposure for
`Mcp-Session-Id`, and re-bundling an SDK into the UI.

The Vite dev server still proxies `/mcp` through to the MCP server. That path
exists so `npm run inspector` and manual `curl` work against the same origin the
UI uses; the UI does not use it.

---

## ADR-005 — Stateless MCP server

**Decision.** `sessionIdGenerator: undefined`. Each `POST /mcp` builds a fresh
`McpServer` and a fresh transport; the shared adapter carries the only state that
matters.

**Why.** Our clients are the orchestrator, the Inspector and short-lived browser
tabs. None benefit from server-side sessions; all of them would leak a session-map
entry. A stateless server also has no failure mode where "the session went stale
and the client does not know".

**Cost:** no `GET` notification stream and no `DELETE` teardown — both return
405. Studio live updates use a separate NDJSON feed at `/events` instead, which
needs no MCP session and no framing negotiation.

---

## ADR-006 — Verification re-reads the document

`{ success: true }` from a tool is **not** evidence. `batchPlay` can report
success and leave the layer somewhere else; a Photoshop document can be edited
between two steps by the user. So after every plan the Orchestrator captures a
fresh snapshot and evaluates declarative expectations against it.

```text
expected  layer "Title" opacity = 70
              ↓  execute
actual    layer "Title" opacity = 70
              ↓
          ✓ Verified
```

The Orchestrator tests include one that makes an adapter *lie* — returning a
position Photoshop never applied — and asserts the run still fails verification.
That test exists because this is the property most likely to rot.

The vision model may add commentary on top, but it can never overturn a failed
state check: it does not see the document any more precisely than we do.

---

## ADR-007 — Expectations are derived, not trusted

`shared/src/photoshop/expectations.ts` states what "it worked" looks like for
each tool from its arguments alone:

| Tool | Derived expectation |
|---|---|
| `rename_layer` | that layer's `name` equals the new name |
| `set_layer_opacity` | that layer's `opacity` ≈ the requested value (±0.5) |
| `set_layer_blend_mode` | that layer's `blendMode` is the requested mode |
| `set_layer_fill_opacity` | that layer's `fillOpacity` ≈ the requested value |
| `move_layer` | `x` / `y` match, ±1 px for rounding |
| `delete_layer` | the layer is absent |
| `resize_canvas` | `document.width` / `document.height` match |
| `create_document` | the new document's `width` / `height` match |
| `set_selection` | the reported selection is the requested size |
| `move_layer_to_group` | the layer's `parentId` is the group, or its parent is named as given |
| `export_*` | the file exists |
| `save_psd` / `save_document` | the file exists |
| `create_text_layer` | the text content reads back |
| `set_text_style` | each requested style value reads back: `tracking`, `fauxBold`, `fauxItalic`, the wrap width |
| `apply_filter` / `flip_layer` / `rotate_layer` | the layer survived and still overlaps the canvas |
| `rasterize_layer` | the layer is now a pixel layer |
| `flatten_document` | one layer remains |
| `convert_color_mode` | the document's `colorMode` is the requested mode |
| `duplicate_document` | the copy carries the requested name |
| read-only tools | nothing — there is nothing to verify |

A mutating tool with **no** expectation is worse than no tool at all, because the
run reports that the step was verified when nothing was checked. Twenty-three of
the forty-seven operations were in that position at one point — a blend-mode step
that did nothing verified clean. `orchestrator/test/orchestrator.test.ts` now
fails if a tool is added to the registry and not accounted for in one of the three
groups above: sampled with real arguments, read-only, or explicitly listed as
not derivable with a written reason.

Only three mutating tools are genuinely not derivable, and each says why in
`expectations.ts`: `trim_document` (the canvas ends up as small as the artwork
allows), `merge_visible_layers` (the layer count drops by an unknown amount), and
`close_document` (the check would be that the document is *gone*, which no
property can express). All three report their own result, appear in the diff, and
are gated on confirmation.

The planner may add its own `expect` entries; those are merged on top and
de-duplicated by key. It cannot remove a derived one. A model that forgets to
prove its work still gets checked.

---

## ADR-008 — The model cannot mark a step safe

`buildPlan` derives `destructive` from the tool registry, not from the draft, and
`evaluateSafety` re-checks the registry at execution time rather than trusting
the plan object. Editing a plan between approval and execution therefore cannot
smuggle a deletion past the gate — there is a test for exactly that.

A rejected step is **skipped**, not fatal: if a plan is
`rename → delete Background → export` and the user refuses the delete, the export
still happens. A gate that punishes the whole run teaches people to approve
blindly.

---

## ADR-009 — JEV abstains rather than guesses

The fast path exists so that "hide Background" costs 25 ms instead of a model
round trip. Its rules abstain in every ambiguous case:

- the layer name does not resolve → `llm`
- the name is ambiguous (two "Title" layers) → `llm`
- no document is open → `llm`
- the instruction is compound ("…and then…") → `llm`
- confidence is below `JEV_MIN_CONFIDENCE` → `llm`

One deliberate narrowing: the brief's example "set opacity to 70%" names no
layer. That is only unambiguous in a single-layer document, so the rule accepts
it there and abstains otherwise. Guessing which layer to fade is the exact
failure a fast path must not have.

Two implementations sit behind `JevRouter`: the built-in deterministic engine and
`RemoteJevRouter`, which posts to a real JEV runtime when `JEV_RUNTIME_URL` is
set. The Orchestrator cannot tell them apart — that is the point of the interface.

---

## ADR-010 — A mock adapter, not a mock Photoshop

`MOCK_PHOTOSHOP=true` swaps `PhotoshopAdapter` for `MockPhotoshopAdapter`: a real
in-memory document model with real validation, real typed errors, real files on
disk and a real PNG encoder for previews and exports. It is not a stub.

It exists for two legitimate purposes and one illegitimate one it is guarded
against:

- **Development** — run the whole pipeline with no Photoshop licence.
- **Tests** — the orchestrator, verification and repair-loop suites need a
  document they can mutate deterministically.
- **Not the production path** (§31). It is selected only by configuration; there
  is no code path that silently degrades to it.

---

## ADR-011 — Writing a value is not the same as applying it

The UXP DOM accepts assignments it does not intend to honour. `style.strikeThrough
= 'strikethroughOn'` returns without throwing and leaves the text unchanged;
`layer.translate()` behaved the same way in an earlier revision and made a
`move_layer` step report success for a layer that had not moved a pixel.

So an operation that patches state reads the values back and reports two lists
rather than one:

```
applied:  ["tracking", "fauxBold", "paragraphWidth"]
ignored:  ["strikethrough"]
```

`ignored` is the whole point. A caller — a planner, a person reading the run —
needs to know that a request was dropped, and a single `applied` list cannot say
so. This is also what makes the derived expectation for `set_text_style` worth
having: `strikeThrough` is now readable, so "I asked for strikethrough and it is
still off" is a fact rather than an absence of evidence.

The same reasoning produced the `withinCanvas` field on a layer snapshot, and
`text.strikethrough_enum` in the capability report: on this build
`Constants.StrikeThrough` exists but is not usable, and the report says exactly
that instead of implying the feature is there.

Related, and easy to get wrong: `Constants.Underline` and
`Constants.StrikeThrough` are **different enums and are not interchangeable**.
Writing an underline value into the strikethrough field is how a strikethrough
request was once turned into nonsense. The "on" value is derived from what
Photoshop currently reports (`strikethroughOff` → `strikethroughOn`) so a build
that spells it differently still works.

---

## ADR-012 — The servers must be restarted, or the evidence lies

A running server keeps the `dist/` it loaded at start-up for its whole lifetime.
Rebuilding without restarting produces a failure that points at the wrong thing
entirely: the plugin reports a new field, a result schema that predates the field
strips it, and a check written against that field fails for a reason that no
longer exists anywhere in the source.

`scripts/dev-up.ps1` therefore builds before it starts anything, and refuses to
start the servers at all if that build fails. Rebuilding by hand and re-probing
without a restart is how an hour went into proving a field was missing from a
response that the process had never been able to send.

Note also that the machine-wide `node` on PATH is older than the toolchain
(`vitest` imports `node:util`'s `styleText`, Node 22+), so a build run outside
`dev-up`/`win-env` fails in the studio bundle while the TypeScript half appears to
succeed. Pin the local Node 22 first.

---


An open escape hatch — a tool that runs arbitrary ActionDescriptors, or arbitrary
JavaScript — would let a model bypass schema validation, the workspace allowlist
and the confirmation gate in one call. It would also make every safety property
in this document decorative.

`batchPlay` therefore exists in exactly two sanctioned places, and a test walks
the plugin source to keep it that way:

- `photoshop-plugin/lib/ps.js` — the wrapper that runs descriptors and inspects
  the result for `{_obj: 'error'}`
- `photoshop-plugin/lib/ops/*.js` — the individual adapter methods

Every capability the AI can reach is a named, schema-checked, expectation-checked
operation. If the model needs something new, it is a new tool, reviewed like
code.

---

## ADR-013 — Five more from the DOM, two of which could not be built

With the platform boundary settled, the reachable surface was worked through one
method at a time. Five tools came out of it, each confirmed against Photoshop
26.11 before being called done:

| Tool | What it does | Verified on the host |
|---|---|---|
| `list_fonts` | the installed fonts, with `postScriptName` | 562 faces; 12 under a `myriad` search |
| `modify_selection` | grow, shrink, expand, smooth, border, invert, selectAll, deselect | each action; `deselect` reported as `selectionActive: false` and the state persisted |
| `duplicate_layers` | copy a layer, named and placed | copy made and renamed; `duplicate` returns the new layer |
| `apply_image` | composite another open document onto a layer | exports before and after differ by MD5 — it really changes pixels |
| `set_layer_locking` | lock a layer | flags accepted — but see below |

`list_fonts` exists because a font name is checked at *render* time, not at edit
time. A plan that guesses "Inter" produces a layer that looks right in the
snapshot and wrong in the export. `postScriptName` is the field to pass on,
because a family has a Regular, a Bold and an Italic and they are different fonts
sharing one family name.

**A solid fill is not available, and the tool was removed rather than shipped.**
It was implemented three ways before being taken out:

1. `createPixelLayer({ fill })` — accepts the fill, ignores it, and returns a
   correctly-named pixel layer of size 0×0.
2. `selection.fill(solid)` — the method that would be the obvious answer. It does
   not exist on 26.11.
3. the `fill` descriptor through `batchPlay`, in both of its spellings. Both are
   accepted and both leave the layer 0×0.

The layer existed, was named, and reported `type: "pixel"` at every step. Only its
bounds showed there was nothing in it. It is recorded as `layer.fill` in the
capability report so nobody tries a fourth route.

That is also what `withinCanvas` was built for, and it earned its place here: the
derived expectation for this tool now checks it, so an empty layer fails
verification instead of passing. `sample_color` refused to sample any point in
those documents, which is what first surfaced the problem — its own error message
now says so, because "Could not interpret the colour Photoshop returned" sent
looking for a colour-parsing bug that did not exist.

**`set_layer_locking` is the interesting one.** `setLocking` is accepted and the
flags take effect, but nothing can read them back: `layer.locked` stays `false`
whatever was requested, and `lockedTransparency` / `lockedPosition` are not on the
DOM at all. So:

- the tool reports `locking` (what was asked for) and `lockReported` (what came
  back) side by side, rather than echoing one and hiding the other;
- it has **no** derived expectation. A check against `isLocked` would fail every
  time; one that echoed the request back would only prove the plugin sent it;
- `get_capabilities` records the gap as `layer.lock_readback`, so a planner sees it
  before relying on it.

An earlier version turned the read-back mismatch into an error, which made a
working feature unusable — the host not reporting a value is not evidence the
operation failed.

### How the shape of a host object was established

Property names such as a font's `postScriptName` are in no document this project
can consult, and guessing them produces code that reads `undefined` and reports
success. `get_capabilities` now returns a `samples` block naming the keys the
host actually has — which is how `Constants.StrikeThrough` was found to be a
separate enum from `Constants.Underline`, and how `lockedTransparency` was found
to be absent rather than merely misnamed.

### The fixture the live sweeps depend on

`data/probes.jsonl` is not self-contained: it expects a document with `Title`,
`CTA`, `Logo` and `Background`, built by `scripts/make-demo-document.jsx`. Run
against an accumulated document it fails with "layer not found" and reads exactly
like a regression — five of twenty-eight probes failed that way before the cause
turned out to be state, not code. Rebuild the fixture before a sweep, and treat
"layer not found" in one of these files as a fixture question first.

---

## End-to-end walkthrough

The demo request: **"Create a square version of this banner."**

1. **Studio** `POST /api/chat` with the user's words.
2. **Orchestrator** captures a snapshot *before* planning. The planner never
   reasons against assumptions.
3. **JEV** gets first refusal. "Create a square version" is compound, so it
   abstains and the request goes to the planner.
4. **Model Gateway** returns a draft: `duplicate_document` → `resize_canvas` →
   per-layer scale/move → `export_png`.
5. **Plan builder** assigns ids, resolves defaults, validates every argument,
   derives destructive flags from the registry, derives expectations, and builds
   the confirmation question for `export_png`.
6. **Studio** renders the plan and returns `awaiting_confirmation`.
7. **User** approves. `POST /api/runs/:id/approve`.
8. **Executor** walks the steps. Each one is an MCP call; the MCP server
   validates, applies path policy, and forwards over the WebSocket bridge.
9. **Plugin** opens one modal scope per operation, runs the DOM call or the
   `batchPlay` descriptor, checks for an error descriptor, and replies.
10. **Orchestrator** captures a second snapshot, diffs before/after, and
    evaluates all expectations.
11. **Studio** shows the diff, the verification report, and the log.

```
✓ Completed

Canvas
1920×1080 → 1080×1080

Layers changed: Background · Company Logo · Title · Subtitle · CTA

Verification:
✓ document.width  1920 → 1080
✓ document.height 1080 → 1080
✓ x of "Title"    expected 251, actual 251
✓ file out/banner-1080x1080.png exists
…
```

If verification fails and the errors are recoverable, the repair loop runs up to
`AI_MAX_REPAIR_ATTEMPTS` times. A non-recoverable error stops it immediately —
re-planning against an unchanged document is how you build an infinite loop.

---

## Security model

| Threat | Control | Where |
|---|---|---|
| Model deletes or overwrites without consent | destructive flags in the registry, re-checked at execution | `shared/photoshop/operations.ts`, `orchestrator/src/execution/safety.ts` |
| Model reads or writes arbitrary files | `Workspace` allow-list; path rejected before the bridge | `mcp-server/src/workspace.ts`, plugin `assertInsideWorkspace` |
| Model runs arbitrary code in Photoshop | no such tool exists; `batchPlay` only inside adapter methods | `photoshop-plugin/lib/ops/*` |
| Model reaches the shell | no process spawning anywhere in the request path | — |
| DNS rebinding against a localhost service | `Host` header allow-list before any handler | `mcp-server/src/http.ts` |
| API keys in the browser | the UI only ever talks to `/api`; keys live in the Orchestrator's env | `orchestrator/src/gateway/*` |
| Inline handlers needing code generation | `addEventListener` only; `allowCodeGenerationFromStrings` is **not** requested | `photoshop-plugin/index.js` |

The workspace allow-list is applied **twice** — once in the MCP server and once
inside Photoshop. The plugin is the code that actually opens files, so it does
not take the server's word for it.

---

## Failure modes

| Situation | Behaviour |
|---|---|
| Photoshop closed / plugin not loaded | `NOT_CONNECTED`, recoverable. Tools fail with a message naming the expected bridge URL; Studio shows the plugin as disconnected. |
| Plugin reloads mid-run | In-flight request rejected with `NOT_CONNECTED`; recoverable, so the repair loop retries against the fresh connection. |
| Photoshop busy in another modal scope | `MODAL_STATE` (`error.number == 9`), recoverable — the plugin surfaces it instead of failing obscurely. |
| Tool argument fails the JSON Schema | JSON-RPC `-32602` from the SDK, before dispatch. Classified as a recoverable error by the MCP client so the repair loop can fix the call. |
| Layer name is ambiguous | `INVALID_PARAMS` listing the candidate ids. Never guesses. |
| File already exists | `FILE_EXISTS`, recoverable, with the instruction to set `overwrite`. |
| Plan verification fails | Repair loop, bounded by `AI_MAX_REPAIR_ATTEMPTS`; a non-recoverable error short-circuits it. |
| Model unreachable / no API key | `MODEL_UNAVAILABLE`, recoverable. With `provider=mock` the deterministic planner keeps the pipeline alive offline. |
| Request cannot be planned | The model is asked to phrase a clarification; the run is recorded as failed with `PLAN_INVALID`, never as a silent no-op. |

---

## Adding a creative application

Illustrator, Premiere or Blender would slot in **beside** the AI core, not inside
it. The seams already exist:

1. `shared/photoshop/*` becomes `shared/illustrator/*` — same shapes: a
   document/layer model, an adapter contract, an operation registry, snapshot,
   diff and expectations. `DocumentSnapshot` and `DocumentDiff` are generic
   enough to share outright.
2. A second MCP server implements `PhotoshopAdapter`'s sibling interface and
   exposes `illustrator.*` tools. The Orchestrator's `McpClient` becomes a
   registry of MCP endpoints rather than one URL.
3. `ModelGateway` is unchanged — it is told which tools exist and what state it is
   looking at, and it does not know what a layer is.
4. Studio gains a second source selector. The chat, plan, diff, verification and
   history surfaces are per-endpoint and already generic.

Nothing in `orchestrator/src/gateway/` or `orchestrator/src/state/` would change.
That is the test of whether this architecture is doing its job.

---

## Platform boundary: read the DOM, not the reference

The tool surface is bounded by what Photoshop 26.11 / UXP 9.0.2 will actually
perform — and the bound is not where the API reference puts it.

**Almost everything is reachable through the UXP DOM.** `get_capabilities` reads
the live objects to find out what, and the surface is far larger than the API
reference suggests: `document.crop`, `trim`, `flatten`, `mergeVisibleLayers`,
`splitChannels`, `calculations`, `changeMode`, `convertProfile`, `sampleColor`,
`suspendHistory`, `createPixelLayer`, `duplicateLayers`, `guides`, `artboards`,
`layerComps`, `pathItems`; about thirty-five `Layer.apply*` filters,
`rasterize`, `flip`, `rotate`, `skew`, `applyImage`, `merge`, `clear`, `trim`,
`setLocking`, mask density and feather, layer linking; a `Selection` with
`grow`, `expand`, `contract`, `smooth`, `selectBorder`; a `TextItem` with
`warpStyle`, `convertToShape`, and a `characterStyle` carrying more than thirty
properties.

**`batchPlay` is the last resort, and on this build it does not work.** Every
descriptor tried was accepted without error and did nothing, was refused, or hung:

| Attempted | Outcome |
|---|---|
| `crop` (descriptor) | refused: "The user cancelled the operation" |
| `transform` (offset, scale) | every form accepted; the layer never moved |
| `textStyleRange` / `set` | accepted; opened a modal dialog that wedged the plugin |
| `make` (layer mask) | accepted; no mask appeared |
| `make` (adjustment layer) | accepted; the layer stack came back *different* |

`batchPlay` resolving is not evidence that anything happened, and the adjustment
case shows that checking afterwards and failing is not a safe pattern either — the
document was left altered.

### A correction worth recording

An earlier version of this document concluded from the table above that masks,
adjustment layers, channels and cropping were *unreachable on Photoshop 26.11*.
That was wrong, and wrong in the useful direction: `document.crop` is on the DOM
and works, and so is everything else in the list above. The descriptors were
broken; the features mostly were not. The mistake was inferring the size of the
DOM from a handful of hand-picked property checks, and treating a failed
descriptor as a missing feature.

The rules that came out of it, which are what the code now follows:

- **Enumerate, do not guess.** `get_capabilities` is built from the live objects.
  Anything added later starts there.
- **DOM first, descriptors only for what the DOM genuinely lacks.** And on this
  build, that set is: mask creation, smart objects, adjustment layers.
- **Read the result back.** Several DOM methods return normally having done
  nothing, and one (`document.changeMode`) reports a result the document does not
  have. Every mutating tool verifies and refuses if the value did not land.
- **Select the layer first.** `translate`, `scale`, `flip`, `rotate` and the
  filters act on the *active* layer. A user watching the document sees the
  selection move.

### Consequences for coverage

Implemented: documents (create, read, duplicate, save, close, list, crop, trim,
flatten, merge visible, colour-mode conversion, colour sampling); layers (create,
delete, rename, reorder, group, move, scale, flip, rotate, rasterize, visibility,
opacity, blend mode, fill opacity, locking surface); text (create, read, update,
position, size, colour, style patch); images (place, resize, twenty-five
filters); canvas (resize, selection with grow/expand/contract/feather); export
(PNG, JPG, PSD, preview).

Deliberately absent, and why:

- **Mask creation and smart objects.** No DOM equivalent, and `make` /
  `convertToSmartObject` are among the failures above. A tool that reported a mask
  it could not verify would be worse than no tool, and `convertToSmartObject` hung
  the bridge outright. Mask *density* and *feather* are readable and settable, and
  are exposed.
- **Adjustment layers.** `make`, same reason.
- **Generative Fill, Neural Filters, Remove Background.** Cloud services behind a
  modal UI; not reachable without a human in the loop, and not something to hand a
  plan.
- **PDF, print, export presets.** Photoshop's own dialogs.
- **Vector paths, shapes, video, 3D, actions, batch.** Vastly larger surfaces, each
  needing the descriptor path that does not work here.

The honest summary: this is a capable layout, type and image-processing tool for
existing artwork — not a Photoshop replacement. A tool that claimed the rest and
silently did nothing would be worse.

---

## Known limitations

Stated plainly, because they are the things most likely to surprise.

1. **The deterministic planner does not synthesise repairs.** With
   `AI_PLANNER_PROVIDER=mock` the repair loop is exercised but declines to fix
anything it cannot derive mechanically from the verification report. Repairs are
useful with a real provider.
2. **`resize_canvas` does not scale content.** That is correct Photoshop
   behaviour; the planner is responsible for follow-up `move_layer` /
   `resize_layer` steps, and the bundled deterministic planner does that.
3. **No "selected layer" concept.** "Set opacity to 70%" needs a target. The
   bundled planner resolves it from a named layer or, for a single-layer
document, from the only layer.
4. **The mock adapter writes a JSON placeholder for `.psd` and `.jpg`.** PNG is
   real. Files are real; PSD/JPEG bytes are not. `file_exists` verification is
therefore honest, but do not open a mock `.jpg` in Photoshop.
5. **`ws://localhost` is verified on Windows only.** macOS ATS may require a TLS
   tunnel in front of `PLUGIN_PORT`.
6. **A created document cannot be named.** `Document.name` is a getter on 26.11,
   so `create_document` reports the name Photoshop gave it.
7. **`characterStyle.underline` has no plain "on"** in this build — the enum holds
   only the vertical-text variants. `set_text_style` applies the closest one and
   the capability report says so.
8. **Geometry operations change the selection.** `Layer.translate` /
   `Layer.scale` / `Layer.translate` for masks and smart objects all act on the
   active layer, so the plugin selects the target first. A user watching the
   document will see the selection move.
9. **`manifestVersion: 6` is not used.** Photoshop documents v4 and v5; there is
   no Photoshop documentation for v6.

---

## Research notes and sources

Read before extending the plugin. All verified against Adobe's documentation in
September 2026.

**UXP networking**
- <https://developer.adobe.com/premiere-pro/uxp/resources/recipes/network/> —
  WebSocket is client-only; plugins cannot host.
- <https://developer.adobe.com/photoshop/uxp/2022/guides/uxp-guide/uxp-misc/manifest-v5/> —
  deny-by-default permissions; `network.domains` requires explicit schemes.
- <https://developer.adobe.com/photoshop/uxp/2022/uxp-api/changelog3-p> — top-level
  wildcard domains rejected from UXP 7.4 (PS 25.5).
- <https://github.com/AdobeDocs/uxp-photoshop/issues/321> — `127.0.0.1` alone is
  not understood by the manifest parser.
- <https://github.com/AdobeDocs/uxp-photoshop-plugin-samples/tree/main/io-websocket-example>
  — Adobe's own working plugin↔local-server sample.
- <https://developer.adobe.com/photoshop/uxp/2022/uxp-api/known-issues> — self-signed
  TLS does not work with `wss` on macOS; WebSocket extensions unsupported.

**Photoshop UXP API**
- <https://developer.adobe.com/photoshop/uxp/2022/ps_reference/classes/document/>
  — `saveAs.<format>(entry, options, asCopy)` is an object of functions; there is
  no `exportDocument`; the property is `mode`, not `colorMode`.
- <https://developer.adobe.com/photoshop/uxp/2022/ps_reference/objects/createoptions/textlayercreateoptions/>
  — `document.createTextLayer` (24.2+).
- <https://developer.adobe.com/photoshop/uxp/2022/ps_reference/media/batchplay/>
  — `batchPlay` resolves on failure; inspect `_obj === 'error'`.
- <https://developer.adobe.com/photoshop/uxp/2022/ps_reference/media/executeasmodal/>
  — `commandName` is required; `number == 9` means the modal scope is taken.
- <https://developer.adobe.com/photoshop/uxp/2022/ps_reference/media/photoshopcore/> —
  `getLayerTreeSync`, `getLayerGroupContents`.
- <https://developer.adobe.com/photoshop/uxp/2022/guides/debugging/> — the UXP
  Developer Tool is the only supported way to load a development plugin.

**MCP TypeScript SDK**
- <https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x> — v1.31.0 is
  the current release of the monolithic package; v2 is a package rename and a
  breaking API change, tracked separately in `docs/development.md`.
- <https://modelcontextprotocol.io/specification/2025-11-25/server/tools> — tool
  names may contain dots, which is what makes `photoshop.get_document` legal.
- MCP SDK behaviour worth knowing: the tool `outputSchema` is only advertised
  when the schema's root is an *object*; a root union is silently dropped. The
  result envelope here is therefore one flat object with two optional payloads.

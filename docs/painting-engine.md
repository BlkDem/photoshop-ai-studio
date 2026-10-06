# Painting engine

Status, architecture and next iteration for the AI painting engine.

**Last updated: 2026-10-05.** Working tree is uncommitted on `main` at `bccfeb6`.

---

## 1. Status

The engine is built and **verified end to end against real Photoshop 26.11.7** — MCP
→ WebSocket bridge → UXP plugin → Photoshop. A stroke painted by the engine lands
as real pixels on a real paint layer, with a genuinely soft edge.

| Area | State |
| --- | --- |
| `paint-engine/` package | built, 136 tests |
| Palette / Composition / Depth engines | built, tested |
| 11 procedural stroke primitives | built, tested |
| PaintEngine: batching, fill budget, progressive phases | built, tested |
| Normalized coordinates (resolution independent) | built, tested |
| Synthesized tips in plugin + mock | built, differential-tested |
| Stroke verification (pixels actually moved) | working — caught 3 real bugs |
| Batched `paint_strokes` MCP op | **not built** |
| ArtDirector (request → PaintingPlan) | **not built** |
| Orchestrator wiring / checkpoint guard | **not built** |
| Studio PAINT mode | **not built** |
| VisionCritic + repair loop | **not built** |

Tests: **565 passing** (23 files), identical in both checkouts. Lint is clean except
7 pre-existing errors in files this work has never touched.

### Last verified run

```
photoshop.create_document          960x540                    success
photoshop.paint_stroke             methodUsed: rasterized-stroke-synthesized-tip
                                   stampsPainted: 688
                                   samplesChanged: 5/5   verified: true
                                   tipIsSynthesized: true
```

---

## 2. Measured platform facts

Everything here was measured on Photoshop 26.11.7 / UXP 9.0.2, not read from
documentation. Several contradict what the codebase previously believed.

### Photoshop's brush engine is unreachable from both doors

- **UXP**: four routes measured dead (script execution, menu commands, the
  `_obj: 'stroke'` descriptor, `_obj: 'paint'`). See `capabilities.js`.
- **ExtendScript/COM**: `app.brushes` and `app.activeBrush` are both `undefined`.
  With no `Brush` object, `PathItem.stroke()` cannot be called at all.

`capabilities.js` previously claimed the COM route worked and cited
`scripts/brush-firework.jsx` as proof. **It does not** — run, it reports
`brushUsed=false; bursts=-1` and dies on `app.brushes`. That claim has been
corrected and the script relabelled as a reproduction. `scripts/probe-brush-dom.jsx`
prints the measured facts without attempting a stroke.

Consequence: **a brush here is a synthesized tip, not a Photoshop preset.** Every
preset carries `tipIsSynthesized: true` and every result reports
`methodUsed: rasterized-stroke-synthesized-tip`. Do not let this drift.

### UXP *can* create a pixel layer with area

This overturns ADR-013 / `layer.create_pixels` ("this host cannot make a pixel
layer with area in it"). That was only ever measured via
`createPixelLayer({ fill })`. The working route is:

1. `doc.createLayer()` — **does not select what it creates**
2. `ps.resolveCreatedLayer()` — the handle's `id` is not populated yet; assigning
   it to `activeLayers` is a UXP *type error*, not a no-op
3. `ps.selectLayer()` — otherwise the fill lands on the previously active layer
4. `selection.selectRectangle()` + `ps.fillSelection()` — the layer grows to the
   filled area

Steps 1–3 were each a separate bug. Step 3 in particular also meant
`paint_stroke` with `newLayer: true` painted onto the **wrong layer** while the
tool description promised otherwise.

### UXP will not accept an IP literal in the bridge URL

`ws://127.0.0.1:3002/bridge` is refused with *"Permission denied … Manifest entry
not found"* regardless of how `requiredPermissions.network.domains` is spelled —
not `ws://127.0.0.1/`, not `ws://127.0.0.1:3002/`, not `ws://*` (top-level
wildcards are rejected outright from UXP 7.4). The parser discards IP-literal hosts
before permission matching.

The plugin must dial `ws://localhost:3002/bridge` and the manifest must declare
`ws://localhost/`. ADR-001 records this; `contract.test.ts` now pins it, because
it is exactly the detail someone "fixes" while chasing a network problem.

### Other host behaviour worth knowing

- `document.close(SaveOptions.DONOTSAVES)` raises a modal save prompt **even after
  `saved = true`**. A modal prompt raised inside a COM-driven script wedges the
  channel permanently: the script never returns and every later `DoJavaScript`
  fails with `RPC_E_SERVERCALL_RETRYLATER`. Never close a document from a probe.
- UXP loads plugin JavaScript at startup, so a plugin change needs a Photoshop
  restart. `scripts/reload-plugin.sh` uses `Stop-Process -Force` and will destroy
  unsaved work.
- The plugin folder under `%AppData%\Adobe\UXP\Plugins\External\` is
  installer-owned and **not writable**. The plugin's own log lives in its data
  folder instead (see §6).

---

## 3. Architecture

```
user request
     ↓
Art Director            ← NOT BUILT (deterministic recipes for now)
     ↓
PaintingPlan            validated by zod; names layers, brushes, regions
     ↓
StrokeGenerator         recipes → SemanticStroke with real points
     ↓
PaintEngine             cost budget, batching, progressive phases
     ↓
PaintTarget             adapter seam: UXP bridge | mock | tests
     ↓
photoshop.paint_stroke
```

The engine is LLM-agnostic by construction: it never calls a model, and a model
never calls it. **A model never emits coordinates** — `PaintingPlanSchema` accepts
regions and parameters only, and points are the engine's job.

Key properties:

- **Deterministic.** Every random choice comes from `plan.seed` via `mulberry32`.
  `Math.random` is not used anywhere in the package. One plan always paints one
  picture, which is what makes a diff of two renders meaningful.
- **Resolution independent.** Brush diameters are a fraction of the canvas's
  *shorter* side, so a plan composed at 1920×1080 renders the same picture at
  3840×2160.
- **Cost-aware.** Each stamp is one `selectEllipse` plus one `batchPlay`, so
  *fills are wall-clock time*. A `steps`-ring tip costs `steps` fills per stamp.
  `budgetStamps` opens spacing rather than dropping marks when a layer exceeds the
  budget, and reports `degraded` so the caller can say so.

### Files

```
paint-engine/src/
├── types.ts               vocabulary; the model↔engine contract
├── random.ts              seeded mulberry32
├── validation.ts          zod schemas + cross-field rules
├── brushes/catalog.ts     8 presets, depth response
├── brushes/tip.ts         tip falloff → rings; alpha floor
├── palette/engine.ts      HSL colour maths, five-role palettes
├── composition/engine.ts  horizon, focal point, depth bands
├── strokes/primitives.ts  line curve wave arc cloud hatch dabs glaze …
├── strokes/generator.ts   recipe → SemanticStroke
├── layers/strategy.ts     stage order → Photoshop stack order
├── renderer/coordinates.ts normalized → pixels
├── renderer/batches.ts    fill budget, batching
└── paint-engine.ts        facade + progress reporting
```

---

## 4. Known limitations

Stated plainly because each one will otherwise be rediscovered the hard way.

1. **Coarse spacing bands.** A soft tip is concentric discs, so at the default
   spacing the individual stamps are visible as beads. At `spacing: 0.12` the mark
   reads as a proper airbrush. Dense spacing costs fills — this is a quality
   against wall-clock dial, and the engine already exposes it.
2. **`MIN_FILL_ALPHA` is conservative, not characterised.** A fill asked at ~2.4%
   deposited nothing on this host; 7.7% worked. The floor at 2.5% guarantees ink
   without collapsing the rim, but the true threshold is unmeasured. It is applied
   to the *base* alpha before the ring weight — flooring the product would clamp
   the faint rim up to the core's alpha and flatten the soft edge into a disc.
3. **No undo bracket.** `suspendHistory` cannot span a multi-request run
   (ADR-014). A stopped painting is a partially painted document, not a rolled-back
   one — which is why a run must happen on a checkpointed duplicate.
4. **One network call per stroke.** The engine batches, but the MCP surface still
   takes one stroke per call. This is the single biggest remaining cost.

---

## 5. Next iteration

In priority order.

### 5.1 Batched `paint_strokes` MCP op

The engine already hands over a whole layer's strokes in one `paint()` call, but
`AdapterPaintTarget` loops one `paint_stroke` per stroke because that is all the
adapter surface allows. A dense tip stroke is ~688 fills, so a painting is
thousands of round trips.

Add `photoshop.paint_strokes`: one call, one modal scope, many strokes. The loop
belongs in the *adapter*, not the engine — the engine must not know how a batch
travels. This unblocks §13 and is the prerequisite for everything below being
usable.

### 5.2 ArtDirector

Turn a natural request into a `PaintingPlan`. Should be deterministic first
(recipes for sky/sea/foam/light), with the model filling in style and palette only.
`orchestrator/src/gateway/deterministic.ts` already holds paint recipes as prose and
is the natural seed for it.

### 5.3 Orchestrator wiring

- checkpoint / duplicate guard before a paint run (§25)
- bounded iterations, `PAINT_MAX_ITERATIONS=3`
- progress events on the existing NDJSON stream

### 5.4 Studio PAINT mode

`CHAT | PAINT | PLAN | HISTORY`, plan approval before painting, live progress with
pause/stop.

### 5.5 VisionCritic

Preview → structured critique → one bounded repair pass. The deterministic
critique is worth building before the model-based one; the plumbing is the work.

### 5.6 Remaining docs

`docs/brush-system.md`, `docs/semantic-strokes.md`, `docs/art-director.md`,
`docs/vision-critic.md`.

---

## 6. Working on this

### Two checkouts — the running one is the Windows one

| | Path | Role |
| --- | --- | --- |
| WSL | `/home/maksim/projects/photoshop-ai-studio` | edit here |
| Windows | `C:\Users\maxim\photoshop-ai-studio` | **the services that actually run** |

The Windows stack (`mcp-server` pid, `orchestrator`, vite on :3000) owns port 3002
on the Windows side, so it is who Photoshop talks to. A `mcp-server` started in
WSL is a duplicate that nothing connects to — measuring against it produces
confidently wrong conclusions about the plugin.

Keep them in sync. `git -C /mnt/c/Users/maxim/photoshop-ai-studio fetch
/home/maksim/projects/photoshop-ai-studio main` then reset, and copy changed files
across. Both are on `main` at `bccfeb6` with identical working trees as of this
update.

### Reading the plugin's own log

The plugin's log is in its writable data folder — not the bridge, and not the
Photoshop console, neither of which is visible from a shell:

```
%AppData%\Adobe\UXP\PluginsStorage\PHSP\26\External\
  com.blkdem.photoshop-ai-studio\PluginData\ai-studio.log
```

It is enabled by `Logger.enableFileSink('ai-studio.log')` in `index.js`. **This is
the fastest way to diagnose a plugin problem** — it is how the manifest
permission error was finally found, after several wrong theories.

### Verifying against real Photoshop

```bash
# from WSL, edit here; the plugin is a shared install so both see it
bash scripts/install-plugin.sh

# ask Photoshop what it can actually do
bash scripts/with-photoshop-jsx-run.sh scripts/probe-brush-dom.jsx

# drive a tool end to end (run on Windows: the MCP server is there)
powershell -Command "cd C:\Users\maxim\photoshop-ai-studio; node scripts/probe-mcp.mjs get_layers"
```

`scripts/probe-mcp.mjs` uses the same MCP client the orchestrator uses, so what it
prints is what the AI layer sees.

### Do not

- **Do not "fix" the bridge URL to an IP literal.** It is rejected; see §2.
- **Do not use `_obj: 'make'`, `_obj: 'stroke'` or `_obj: 'paint'` anywhere under
  `photoshop-plugin/lib/`.** They hang the host. `contract.test.ts` enforces this —
  it caught a temporary probe sitting in `lib/ops/` that called `make`.
- **Do not close a document from a probe script.** It wedges the COM channel.
- **Do not run `scripts/reload-plugin.sh` with unsaved work open.**
- **Do not add an optional parameter to one stroke operation only.** Zod strips
  unknown keys rather than rejecting them, so the call succeeds and the feature is
  silently absent. That is how `tip` reached the plugin as `tip: null` on every
  real painting stroke. `shared/test/operations.test.ts` now checks both.
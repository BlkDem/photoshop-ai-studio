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
| Batched `paint_strokes` MCP op | built, tested, measured |
| ArtDirector (request → PaintingPlan) | **not built** |
| Orchestrator wiring / checkpoint guard | **not built** |
| Studio PAINT mode | **not built** |
| Orchestrator plan building for painting | built and tested; executor mapping not done |
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
4. **Wall-clock is fills, not transport.** This was measured and it contradicts
   what batching was assumed to be for. `scripts/measure-batching.mjs` runs the
   same marks both ways through one MCP client, so the only variable is the number
   of calls:

   | Workload | separate | batched |
   | --- | --- | --- |
   | 4 strokes, ~1139 fills | 45.7–67.5 s | 50.0–55.3 s |
   | 40 single-stamp dabs | 14.6–15.0 s | 14.2–14.8 s |

   The variance between runs is larger than the effect, so there is **no
   measurable saving** on this host. Every stamp is a `selectEllipse` plus a
   `batchPlay` inside Photoshop, and that is where the time is. An earlier version
   of this document called transport "the single biggest remaining cost"; it is
   not, and the measurement is kept here so nobody re-argues it.

   What actually reduces painting time is fewer fills per stroke — coarser
   spacing, fewer rings — and that trades against quality.

---

## 5. Next iteration

In priority order.

### 5.1 Batched `paint_strokes` MCP op — **done**

One call, one modal scope, one layer, many strokes; the loop lives in the adapter
so the engine stays ignorant of transport. The per-stroke failures the result
carries are the part that earns it: a painting forty marks in is not discarded
because mark forty-one had no usable points, and `failures` names which ones so
they can be retried alone.

Measured benefit: none that survives the noise (§4.4). It is still the right
*shape* — the engine already produces a layer at a time, and one call per layer is
what it should cost — but it is not a speed feature, and it should not be sold as
one.

Verified on this host: 4 strokes, 1139 fills, one call, one layer, 12/12 samples
moved.

### 5.2 ArtDirector — **plumbing done, painting not**

`direct(request, { seed })` in `paint-engine/src/art-director/` turns a request
into a `PaintingPlan`: `brief.ts` parses what was named, `recipes.ts` holds the
scene knowledge, `director.ts` resolves composition and palette and assembles.
No model is involved — the paint engine must not depend on any LLM, and the only
honest way to honour that is for the thing that decides *what to paint* to be
inspectable code. A model-backed director can be layered on top and must produce
the same plan shape, because the engine cannot tell the two apart.

It returns its `assumptions` rather than deciding quietly, and proposes a scene
palette when the request names no colours. Both exist because the alternative was a
parser that quietly turns "a calm harbour at dawn" into a storm, with no way for
the user to tell except by looking at a bad picture.

The original plan said `deterministic.ts` already held paint recipes as prose to
seed this from. It does not — that file has no painting vocabulary in it at all.
The knowledge came from the tool descriptions, which is where it should have been
looked for.

**What it does not do yet: paint.** The output is a blue fog, with rope-like bands
where the waves are and a scribble where the ship is. Three causes, in order of
what they cost:

1. **Wave recipes are full-width bands.** Every `wave` region spans `x: 0..1`, so
   the marks come out as horizontal ropes across the whole canvas. They need to be
   broken into overlapping segments of varying length.
2. **`cloud` does not scale down.** At foam-bank size it is a soft rectangle rather
   than a bank. The primitive is right at cloud size and wrong at foreground size.
3. **Overall contrast is far too low.** Nothing in the plan asks for a real
   darkest dark beside a real lightest light, so there is no value range for the
   drama to live in.

None of these are engine bugs; they are recipe work, and it is the kind that needs
a person looking at output and saying "that is not a wave". §7 is what would let a
critic catch some of it without one.

Two engine bugs did turn up while chasing this, both fixed and covered:

- **The preview ignored the document's background.** `renderPreview` hardcoded a
  dark slate for every document, so a request for a white canvas came back
  charcoal. Every "the output looks washed out" judgement made before this was
  fixed was made about the wrong image — a too-dark palette and a correct one were
  indistinguishable in the only artefact anybody looks at.
- **`energy` was in the plan schema and nothing read it.** Opacity came straight
  from the brush preset, so the ceiling on a mark was set by the brush catalog
  rather than by the request, and a recipe asking for a sky at full strength got
  whatever wash the preset happened to define.

### 5.3 Orchestrator wiring — **plan building done, execution not hooked up**

`buildPaintPlan()` in `orchestrator/src/execution/painting.ts` expands a request
into ordinary `Plan` steps: one `duplicate_document` checkpoint, then one
`paint_strokes` step per layer, bottom first. 15 tests.

**Why it expands rather than adding a "paint" step type.** A `PlanStep` is one MCP
tool call, and the executor, the safety gate, the approval UI and the verification
pass all work off that. A painting that ran outside that machinery would be invisible
to every one of them — no approval, no gate, no check. Expanding at plan-build time
keeps the invariant and makes the result a plan a person can read before anything
touches the document.

The checkpoint is not optional. `suspendHistory` cannot span more than one bridge
request (ADR-014), so thousands of fills cannot be bracketed in an undo group: a
painting that fails halfway leaves marks on the document with no way back. Every
painting runs against a duplicate, and the duplicate is left in place rather than
flattened, so the user can see what happened and choose.

**Not yet done:** the executor does not resolve the duplicate's id and redirect the
paint steps at it, and the painting steps currently address `'active'`. That is the
one real gap and it is why painting is not reachable from `submit()` yet. Plans are
data, so a step cannot know an id that does not exist until the checkpoint above it
has run — the executor has to carry the mapping, and that is a change to the
executor rather than to the plan builder.

Still to do here: the executor's checkpoint-id mapping described above, bounded
iterations (`PAINT_MAX_ITERATIONS=3`), and progress events on the existing NDJSON
stream.

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

## 7. Vision Critic — **structure only, and that is the whole limit**

`critique(plan, image)` in `paint-engine/src/critique/` reads a rendered PNG and
reports where the picture failed, using only measurements. `measure()` computes a
robust value range, RMS contrast, coverage against the image's own median, the mean
luminance difference across the horizon, saturation, and local contrast at the focal
point; `critique()` turns those into findings with the number that produced them.

Every number comes from pixels, never from the plan. A critic that reads the plan can
only say what was *asked* for, and a plan asking for a dramatic sky passes a
dramatic-sky check while producing a grey fog. Percentiles rather than min/max
everywhere: one stray saturated pixel sets a min/max pair, and extremes-based
metrics report a healthy value range for a picture with none.

No model is involved, for the same reason the Art Director has none. A model-backed
critic that writes these findings as prose slots in behind `critique()` without
changing anything above it.

**It scores structure, not quality, and the field is named that way.**
`structureScore` reached **94** on a seascape whose waves are still full-width ropes
and whose ship is still a scribble. That is the honest ceiling of this critic: a
picture can have a full value range, real contrast and a visible horizon and still be
a bad painting, because nothing here looks at whether the marks are *of* anything.
Use the number to sort renders and to fail a build; never to claim a picture is good.
Form is a judgement call and belongs to whoever looks at the picture.

What the numbers are for is stopping the failures that are invisible to the eye from
hiding behind a picture that merely looks soft. It did that immediately. On the
Art Director output it went 71 → 82 → 94, and between those steps it found a third
engine bug:

> **The background layer's schematic band was drawn over the whole painting.**
> `previewPaintedLayerIds` listed layers that had strokes, and the Background layer
> had none, so it got a flat 55%-alpha grey placeholder composited over everything
> on top. That is why the picture measured as living inside a luminance band 0.08
> wide with an invisible horizon — not a recipe problem at all, and I had been
> tuning recipes against it for several rounds. The ground colour now does the
> Background layer's job, so the band does not need to.

The lesson generalises: **the failures that cost the most here were all the ones I
could not see, and all three were one comparison away from being obvious.** Judging
by eye from a low-resolution preview is not a substitute for measuring.

Two limits worth knowing before trusting a number:

- `decodePng` handles 8-bit non-interlaced RGB/RGBA and returns `null` for anything
  else rather than guessing. A critic that misreads a 16-bit PNG and then reports
  confident numbers is worse than one that declines.
- Coverage is measured against the image's own median. On a pale picture that is a
  demanding test, and a warning at 33% against a 35% threshold may be a picture that
  is evenly pale rather than one with holes in it.

## 8. Art Director against real Photoshop

The Art Director's output has now been painted in Photoshop 26.11.7 by
`scripts/paint-in-photoshop.mjs`: directed, compiled to per-layer batches, sent over
MCP, and the real render pulled back and judged by the same critic.
`scripts/preview-and-judge.mjs` does the judging alone, because a painting costs
minutes of fills and a judgement costs a second — re-measuring after a recipe change
must not mean re-painting.

6 layers, 80 strokes, ~276 s of fills, one layer per plan layer, no failures.

### The mock understates the painting, and by a lot

Same plan, same seed, two renderers:

| Measurement | Mock preview | Photoshop | Divergence |
| --- | --- | --- | --- |
| value range | 0.64..1.00 | 0.42..1.00 | twice as dark |
| RMS contrast | 0.63 | 0.85 | +0.22 |
| coverage | 33% | 76% | **2.3x** |
| horizon delta | 0.182 | 0.310 | +0.70 |
| structure | 94 | 99 | — |

**Every threshold in the critic is currently tuned against the wrong renderer.** The
mock's `ringFillAlpha` estimates how a synthesized tip's concentric fills overlap;
Photoshop actually performs them, and the result is darker, denser and higher
contrast than the estimate. A threshold set on the mock will be set roughly two and
a half times too low on coverage.

Practical rule: the mock is for plumbing — did the call land, did the layer get
created, is the stroke count right. Any judgement about how the picture *looks*
needs Photoshop. The recipe tuning in §5.2 was done on mock previews and is
therefore directionally right and numerically suspect.

### What the real render shows that the metrics cannot

`structureScore` is **99** on a picture that is not a seascape. Every stamp is a
visible ring, each glaze reads as a long horizontal tube, and there is one bad
vertical stroke through the middle of the frame.

The rings are the important finding. A synthesized tip is concentric ellipse fills
with falling alpha, and in Photoshop the outer edge of the largest disc is a visible
boundary — a stepped approximation to a soft edge, with the steps showing. It is
worst against a light ground, which is why the white canvas that §5.2 introduced
made it worse rather than better.

That is brush work, not recipe work: more `steps`, a lower `outerAlpha`, or both.
It is the single highest-value fix available and it is in the tip model rather than
in anything the Art Director controls. The one note the critic did raise —
`focal-emphasis` at 0.44, the ship not standing out — is real and is recipe work.

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
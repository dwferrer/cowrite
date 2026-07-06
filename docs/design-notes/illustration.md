# Illustration Pipeline (ComfyUI + VLM Feedback Loop) — Subsystem Design

**App:** Cowrite — a local-first, illustrated long-form co-writing tool ("simple, modern, snappy")
**Subsystem owner:** Illustration pipeline
**Status:** Proposal v1 (2026-07-06)

> **Provenance note.** The product-brief path supplied to this task resolved to `undefined`; per
> the convention already established by the sibling designs, `docs/00-overview.md` is treated as
> the authoritative brief (including its fixed baseline stack). The output path also resolved to
> `undefined`; this file is placed at `docs/design/illustration.md` alongside
> `data-model.md`, `agent-harness.md`, and `context-engine.md`, whose contracts this design
> consumes (and, where noted in §13, extends).

---

## 1. Scope and principles

The illustration pipeline turns "this section deserves a picture" into a committed
`illustration.png` (or `world/images/<entryId>.png`), by way of: a low-model **composer** that
writes a natural-language image prompt from the section's text and relevant world-info; a
**ComfyUI client** that injects that prompt into a user-supplied workflow and retrieves the
image; a low-VLM **critic** that scores the image against the intent; and a bounded
revise-and-regenerate loop that picks the best attempt.

Principles, inherited from the brief and the sibling designs:

1. **The workflow is the user's.** Cowrite never edits, generates, or understands diffusion
   graphs. The user exports an API-format workflow from their own ComfyUI, marks the injection
   points, and drops the file in a folder. All style, samplers, checkpoints, LoRAs, negative
   prompts, and resolution live in that file — "fiddly knobs live in ComfyUI workflows, not in
   the UI" (brief principle 2).
2. **The pipeline is a guest of the agent harness.** It executes inside a harness-owned run
   (`illustrate-section` / `world-image` tasks): the harness owns the queue slot, the abort
   signal, the 10-minute total timeout, and the run record; the pipeline emits `RunEvent`s and
   SSE progress through the provided `RunContext` and commits artifacts only through
   `StorageService` (harness §13.5, data-model §13.4/§13.5).
3. **Agentic quality, not parameter quality.** Better images come from the critique loop, not
   from exposing CFG sliders (brief principle 4).
4. **Files are the truth.** The winning PNG plus its generation metadata land in the work
   directory in human-readable form; the full loop transcript (prompts, critiques, seeds,
   timings) is the run's JSONL file. Nothing about an illustration is app-private.
5. **Test without models or GPUs.** Every behavior in this doc runs against
   `packages/mock-llm` (low model) + the mock ComfyUI server (§11).

Out of scope: task queueing/retries at the harness level (05-agents), where sections and their
staleness come from (02-data-model), context assembly for prose tasks (06-context-engine),
and prose prompt wording (07-prompting).

---

## 2. ComfyUI API integration

### 2.1 Endpoint surface used

We use exactly the stable, documented subset of ComfyUI's HTTP/WS API. Nothing else.

| Endpoint | Use |
|---|---|
| `POST /prompt` | Submit a job. Body `{ prompt: <api-format workflow JSON>, client_id }` → `200 { prompt_id, number, node_errors }`; `400` with per-node errors for an invalid graph. |
| `WS /ws?clientId=<uuid>` | Progress stream: `status`, `execution_start`, `execution_cached`, `executing` (`data.node === null` ⇒ job finished), `progress {value, max}`, `executed {output.images}`, `execution_error`, `execution_interrupted`. Binary preview frames are ignored in MVP. |
| `GET /history/<prompt_id>` | Authoritative result record: `outputs[<nodeId>].images: [{filename, subfolder, type}]` + terminal status. Used at completion and as the polling fallback when the WS is unhealthy. |
| `GET /view?filename=&subfolder=&type=` | Fetch the PNG bytes. |
| `GET /system_stats` | Health check (cheap; returns versions + device info). |
| `POST /interrupt` | Cancel the currently executing job (on task abort). |
| `POST /queue` `{ delete: [prompt_id] }` | Remove our job if it is still queued when we abort. |

`client_id` is one UUID minted per server process at boot; we correlate WS messages by
`prompt_id`, so a stable client id is only needed to receive the stream at all.

### 2.2 Injection points: the `%marker%` node-title convention

The user designates injection points by **renaming nodes in the ComfyUI GUI** so the node title
contains a marker token, then exporting with "Save (API format)". In API-format JSON the title
survives as `_meta.title`:

```jsonc
// workflows/default.json (user-supplied, abridged)
{
  "6":  { "class_type": "CLIPTextEncode", "_meta": { "title": "%prompt%" },
          "inputs": { "text": "placeholder", "clip": ["4", 1] } },
  "3":  { "class_type": "KSampler", "_meta": { "title": "KSampler %seed%" },
          "inputs": { "seed": 0, "steps": 28, "cfg": 5.5, "denoise": 1,
                      "model": ["4", 0], "positive": ["6", 0], "negative": ["7", 0],
                      "latent_image": ["5", 0], "sampler_name": "euler", "scheduler": "normal" } },
  "5":  { "class_type": "EmptyLatentImage", "_meta": { "title": "%width% %height%" },
          "inputs": { "width": 1216, "height": 832, "batch_size": 1 } },
  "9":  { "class_type": "SaveImage", "_meta": { "title": "%output%" },
          "inputs": { "images": ["8", 0], "filename_prefix": "cowrite" } }
}
```

For each marker found in a title, the pipeline overwrites a **fixed, well-known input field** on
that node:

| Marker | Field written | Value | Required? |
|---|---|---|---|
| `%prompt%` | `inputs.text` | composed image prompt (string) | **yes, exactly one** |
| `%seed%` | `inputs.seed`, else `inputs.noise_seed` | fresh random integer per attempt | **yes, at least one** (may appear on several samplers; all get the same seed) |
| `%width%` / `%height%` | `inputs.width` / `inputs.height` | *not varied in MVP* — markers are validated and mapped, but the workflow's own values pass through | no |
| `%output%` | none (selector only) | marks which node's images to collect | no — required only when >1 image-producing output node exists |

**Why node-title markers** (the recommendation): titles are cosmetic to ComfyUI's executor, so a
marked workflow **remains loadable, editable, and runnable inside ComfyUI itself** — the user
iterates on their graph in the GUI, re-exports, and the markers ride along; no hand-editing of
JSON, no side-car mapping file to drift out of sync, and validation reduces to a title scan.
*Rejected:* placeholder strings inside input values (e.g. the text field literally containing
`%prompt%`) — works for strings but not for numeric fields like `seed`/`width` without producing
JSON that ComfyUI can no longer load; a separate hand-written node-id → field mapping in config —
node ids are unstable across graph edits and the mapping silently rots; auto-detecting "the"
`CLIPTextEncode`/`KSampler` — ambiguous the moment a workflow has a negative prompt or a refiner
stage, and silent guessing is how wrong images happen.

**Validation** (at registry load, §3, and re-checked before each submit):

- exactly one `%prompt%` node, and it has a string `text` input → else `workflow_invalid`
  ("mark exactly one text-encode node with %prompt%");
- ≥1 `%seed%` node with an integer `seed`/`noise_seed` input → else `workflow_invalid`. A seed
  marker is mandatory because the loop's whole mechanism is re-rolling: without seed injection
  every attempt would render the identical image (API-format executes the embedded seed as-is,
  and ComfyUI's result cache would short-circuit repeats via `execution_cached` anyway);
- if multiple nodes produce `images` outputs, `%output%` must disambiguate; with a single
  `SaveImage`-like node the marker is optional.

Seeds are drawn as uniform integers in `[0, 2^53)` (`crypto`), recorded per attempt.

### 2.3 The `ComfyClient`

```ts
// apps/server/src/illustration/comfy/client.ts
export interface ComfyProgress {
  phase: "queued" | "generating";
  pct: number | null;              // from progress.value/max while a sampler runs
}

export interface ComfyResult {
  png: Buffer;                     // bytes from /view (cap 32 MB)
  filename: string;
  durationMs: number;
  promptId: string;
}

export interface ComfyClient {
  health(): Promise<{ ok: boolean; detail?: string }>;      // GET /system_stats, 3 s timeout, 60 s cache
  generate(req: {
    workflow: Record<string, unknown>;   // already-injected API JSON
    outputNodeId: string;
    signal: AbortSignal;
    onProgress: (p: ComfyProgress) => void;
  }): Promise<ComfyResult>;
}
```

`generate` algorithm:

```
generate(req):
  ensure ws connected (shared, lazy, auto-reconnect; clientId = process UUID)
  { prompt_id } = POST /prompt { prompt: req.workflow, client_id }     # 400 ⇒ workflow_invalid(node_errors)
  deadline_queue = now + queueTimeoutMs                                 # job sits behind user's other jobs
  deadline_exec  = null
  loop:
    ev = next ws message for prompt_id, OR 2 s tick
    on execution_start:            deadline_exec = now + execTimeoutMs; onProgress(generating, null)
    on progress:                   onProgress(generating, value/max)
    on executing(node == null) or executed or execution_cached-terminal:
                                   break → fetch
    on execution_error:            throw ComfyExecError(node_id, node_type, exception_message)
    on execution_interrupted:      throw Aborted
    on tick:
      if ws silent > wsFallbackMs (10 s) or ws down:
          h = GET /history/prompt_id                                    # polling fallback, every 2 s
          if h.completed: break → fetch
          if h.status == error: throw ComfyExecError(from h.messages)
      if deadline passed:          POST /interrupt (if executing) / POST /queue{delete}; throw Timeout
    on req.signal aborted:         POST /interrupt or /queue{delete}; throw Aborted
  fetch:
    h = GET /history/prompt_id                                          # /history is truth, ws is progress
    img = h.outputs[req.outputNodeId].images[0]                         # >1 image ⇒ take [0], log warning
    png = GET /view?filename&subfolder&type
    return { png, filename, durationMs, promptId }
```

Design points: **`/history` is the source of truth, the websocket is only progress** — a dropped
WS never fails a job, it just degrades to 2-second polling. Submission network errors are retried
twice (1 s → 4 s backoff, per the harness's retry ethos); an `execution_error` is **not** blindly
retried by the client — the pipeline layer decides (§10), because a bad graph fails forever while
a VRAM OOM is transient.

### 2.4 Timeouts, errors, health (defaults; all under `config.comfyui.timeouts`)

| Knob | Default | Rationale |
|---|---|---|
| `healthTimeoutMs` | 3 000 | `/system_stats` is instant when the box is up |
| `connectTimeoutMs` | 5 000 | submit + view fetches; localhost or LAN |
| `queueTimeoutMs` | 90 000 | our job may sit behind the user's own ComfyUI jobs |
| `execTimeoutMs` | 120 000 | brief assumes <20 s/image; 6× headroom covers first-run checkpoint load, which can take a minute |
| `wsFallbackMs` | 10 000 | WS silence before switching to `/history` polling |
| overall task timeout | 600 000 | owned by the harness (its §13.5); bounds the whole loop |

**Health check.** `GET /system_stats` runs (a) at app start, (b) lazily before each pipeline run,
cached 60 s, (c) on demand via `GET /api/illustration/health` (§8). Unreachable ⇒
scheduler-initiated tasks fail quietly into the activity log (section keeps its staleness badge);
user-initiated tasks surface the harness `pipeline` error code with detail
`comfy_unreachable` and a retry button. A configured-but-invalid workflow is reported the same
way with `workflow_invalid` — at app start we validate the registry so the user hears about a
broken marker before the first generation, not during it.

---

## 3. Workflow registry

Named workflows live in **app config** (not per work — they describe the user's ComfyUI install,
not a story): `cowrite.config.json` gains a `comfyui` block, with workflow JSON files beside the
config in `workflows/`.

```jsonc
// cowrite.config.json (additions)
{
  "comfyui": {
    "baseUrl": "http://127.0.0.1:8188",
    "workflowsDir": "./workflows",
    "workflows": {
      "default": { "file": "default.json", "label": "Default (SDXL scene)" }
      // later: "portrait": { "file": "portrait.json", "label": "Portrait crop" },
      //        "hq":       { "file": "hq.json", "label": "Hi-res 2-pass", "execTimeoutMs": 300000 }
    },
    "route": { "section": "default", "world": "default" },   // which named workflow per task kind
    "loop": { "maxAttempts": 3, "acceptScore": 7 },          // §4
    "timeouts": { /* §2.4 overrides */ }
  }
}
```

```ts
// packages/shared/src/illustration.ts
export const WorkflowEntryConfig = z.object({
  file: z.string().min(1),                       // relative to workflowsDir
  label: z.string().min(1),
  execTimeoutMs: z.number().int().positive().optional(),  // per-workflow override (hq is slower)
});
export const ComfyConfig = z.object({
  baseUrl: z.string().url(),
  workflowsDir: z.string().default("./workflows"),
  workflows: z.record(z.string().regex(/^[a-z0-9-]+$/), WorkflowEntryConfig)
             .refine(w => "default" in w || Object.keys(w).length > 0),
  route: z.object({ section: z.string(), world: z.string() })
         .default({ section: "default", world: "default" }),
  loop: z.object({
    maxAttempts: z.number().int().min(1).max(6).default(3),
    acceptScore: z.number().min(0).max(10).default(7),
  }).default({}),
  timeouts: z.object({ /* §2.4 knobs, all optional */ }).default({}),
});

// resolved at load time (apps/server/src/illustration/comfy/registry.ts)
export interface ResolvedWorkflow {
  name: string;                                  // registry key, e.g. "default"
  label: string;
  json: Record<string, unknown>;                 // parsed API-format graph (frozen template)
  injections: {
    promptNodeId: string;                        // the %prompt% node
    seedNodeIds: string[];                       // all %seed% nodes
    widthNodeId?: string; heightNodeId?: string; // mapped, unused in MVP
    outputNodeId: string;                        // %output% or the unique image producer
  };
  contentHash: string;                           // for run metadata / change detection
}
```

The registry loads and validates every file at startup and on config reload; injection mappings
are **derived from the markers, never hand-written** — the marker scan *is* the mapping.
Injection itself is a pure function: `inject(resolved, { prompt, seed }) → deep-cloned graph JSON`
(unit-tested in isolation, §11).

**MVP ships with the structure above and exactly one entry, `default`, used for both `section`
and `world` routes.** The user can add `"portrait"`, `"hq"`, etc. and repoint `route` in config —
no UI for choosing workflows per task in MVP (rejected as a fiddly knob; the config file is the
power-user surface, per brief principle 2). Cowrite ships a **sample** `default.json` (a plain
SDXL txt2img graph with markers applied) as documentation, but the user is expected to replace it
with a workflow matching their own install — we cannot know their checkpoints.

---

## 4. The agentic loop (composer → generate → critic)

Both task kinds run the same loop; they differ only in how the *intent brief* is built:

- `illustrate-section` → intent from the section (title, summary/content, matched world entries);
- `world-image` → intent from the world entry (name, body).

The loop runs on the **low model** (the VLM) via `ctx.lowClient`, with `maxToolRounds = 0` at the
harness level — the pipeline drives its own calls and records them as run events (harness §2,
§4.2). The high model is never involved and never sees images (harness §3.2).

### 4.1 Round structure and defaults

```
runIllustration(intent, workflow, guidance?, ctx):
  brief    = buildIntentBrief(intent, guidance)              # §4.2 inputs; recorded as a run message
  prompt   = compose(lowClient, brief)                       # low-model call #1 (text only)
  attempts = []
  for n in 1..maxAttempts:                                   # default 3
      ctx.emit(pipeline: generating, attempt n)
      seed = randSeed()
      img  = comfy.generate(inject(workflow, {prompt, seed}), onProgress → ctx.emit)
      crit = critique(lowClient, img.png, brief, prompt)     # low-VLM call, image attached (§4.3)
      attempts.push({ n, prompt, seed, score: crit.overall, verdict: crit.verdict, png: img.png })
      if crit.verdict == "accept" and crit.overall >= acceptScore: break     # early exit
      if n < maxAttempts:
          prompt = revise(lowClient, brief, prompt, crit)    # text-only call: apply crit.promptAdvice
  winner = argmax(attempts, by score, tie → latest attempt)  # best-of, §4.4
  commit(winner)                                             # storage write, §6
```

**`maxAttempts` default 3** (1 initial + up to 2 revisions). Reasoning: with <20 s per image and
a few seconds of VLM critique, 3 attempts bound the background task near a minute (table below),
which keeps the illustration lane (capacity 1, global — harness §6.1) draining faster than
chapters freeze; empirically the first revision fixes most misses ("the dragon is missing",
"wrong hair color") while a second revision mostly re-rolls variance — beyond that you are paying
latency for noise. Configurable 1–6 via `comfyui.loop.maxAttempts`; `1` degrades gracefully to
generate-once-no-critique-loop (the critique still runs once to record a score).

### 4.2 Prompt composition (the composer)

**Inputs to the intent brief** (all fetched through storage queries, no context-engine session):

| Input | Source | Cap |
|---|---|---|
| Section title + **long summary** (fall back to `content.md`, truncated) | enrichment files / section content | ~3 000 tokens |
| Matched world entries: full bodies of entries whose `keys` occur in the section text | `world_keys` index scan (data-model §7.2) | 4 entries, ~400 tokens each, most-mentioned first |
| **Established imagery**: the accepted image prompts of previous illustrations that mention any matched entity | `enrichments.illustration.prompt` across sections + world image metas (§6) | last 3 |
| Optional user guidance (regenerate path, §5) | task spec | 500 chars |

The scheduler already orders `enrich-section` before `illustrate-section` (harness §6.1), so the
long summary normally exists; the fallback covers user-forced early illustration.

**Output contract** — one `<image-prompt>` tag block (the harness's §5.2 block for illustration
tasks), containing a **single natural-language descriptive paragraph, 60–120 words**. The
composer's instructions (template `prompts/illustrate-compose.md`, owned by 07-prompting for
wording; this doc fixes the rules):

1. Pick **one concrete visual moment** from the section — a single scene, not a montage.
2. Write flowing descriptive prose: subject first, then action, setting, lighting, mood, and
   framing (e.g. "wide shot", "close portrait"). Present tense.
3. **No tag soup, no quality boilerplate, no negative prompts, no artist names, no resolution
   incantations** ("masterpiece, 8k, trending" is banned). Style and negatives belong to the
   user's workflow; the prompt describes *content only*. This is what makes one prompt portable
   across every registered workflow.
4. **Reuse established imagery verbatim**: when a character or place appears in the
   "established imagery" list, copy its physical description word-for-word rather than
   re-describing it (§7).
5. Never include names the image model can't ground: render "Mara Voss" as her physical
   description ("a weathered woman in her forties with cropped grey hair…"), optionally keeping
   the name *after* the description ("— Mara —" is allowed but decorative).
6. If user guidance is present it wins over everything except rule 3.

Composer and reviser are plain text-only low-model calls (~1–2 s), recorded as `message` +
`output` run events.

### 4.3 The critic (VLM critique)

One low-model call per attempt with the generated PNG attached as an `image_url` part (base64
data URL — the only place in Cowrite where a model receives an image, permitted only on the low
lane per harness §3.2). The critic sees: the intent brief, the exact prompt used, and the image.
It returns JSON (Zod-parsed from a fenced block; one repair retry on parse failure, then treat as
`{ verdict:"revise", overall:5 }` so a flaky critic never wedges the loop):

```ts
export const CritiqueResult = z.object({
  verdict: z.enum(["accept", "revise"]),
  scores: z.object({
    subject: z.number().min(0).max(5),      // is the chosen moment actually depicted? key elements present?
    consistency: z.number().min(0).max(5),  // do characters/places match the established descriptions in the brief?
    craft: z.number().min(0).max(5),        // artifacts: anatomy, garbled text, bad crops, duplicated limbs
    mood: z.number().min(0).max(5),         // tone/lighting/palette vs the section's mood
  }),
  overall: z.number().min(0).max(10),
  problems: z.array(z.string()).max(5),     // concrete, e.g. "the lighthouse is absent"
  promptAdvice: z.string().max(600),        // one actionable rewrite instruction for the reviser
});
```

Guard rail: if `verdict === "accept"` but `overall < 6`, the pipeline overrides to `revise` —
small VLMs are agreeable, the numeric floor keeps them honest. The rubric is deliberately four
axes and no more: each axis maps to a failure the reviser can actually act on (add the missing
subject; re-assert a description; simplify the scene to reduce artifacts; adjust
lighting/palette words). The full critique JSON is recorded as a `toolCall` run event
(`name: "vlm.critique"`), so the provenance view can replay the whole conversation — **the
critique transcript is the run file**, by design; no separate transcript artifact.

### 4.4 Final selection: best-of, with early accept

**Recommendation: keep every attempt's score and commit the highest-scoring image; stop early
when an attempt clears `acceptScore` (default 7/10).** Prompt revision is noisy — attempt 3 can
regress below attempt 1, and since every attempt is already scored, best-of costs zero extra
model calls; last-is-best throws information away for nothing. Ties break toward the latest
attempt (it embodies the most revision guidance). *Rejected:* a final side-by-side pick where the
VLM sees all candidates in one message (multi-image messages are the least portable corner of
OpenAI-compatible VLM endpoints, and per-attempt scores already answer the question);
last-is-best (regression-blind, see above).

Candidate images are held **in memory only** (≤ 6 attempts × a few MB) for the duration of the
run; the winner is committed, the rest are dropped (§6).

### 4.5 Latency & cost budget (assumes <20 s/image, per the brief)

| Step | Calls | Typical | Worst (3 attempts) |
|---|---|---|---|
| Intent brief assembly | 0 (storage reads) | <0.1 s | <0.1 s |
| Compose | 1 low text | 1–2 s | 2 s |
| Generate | 1–3 ComfyUI | 8–20 s each | 60 s |
| Critique | 1–3 low VLM (+image) | 2–5 s each | 15 s |
| Revise | 0–2 low text | 1–2 s each | 4 s |
| Commit | 0 | <0.1 s | <0.1 s |
| **Total** | | **~15–30 s** (accept on attempt 1) | **~80 s** |

Token spend per section: roughly 3–5 low-model calls × 2–4 k prompt tokens ≈ 10–20 k low-lane
tokens — cents at typical small-VLM pricing, and pure background. Every call's usage is recorded
as `usage` run events with `call: "pipeline"` (harness §7), so the `/usage` rollups include
illustration spend without special-casing.

---

## 5. Where illustration tasks come from, and the user's override paths

| Trigger | Mechanism | Priority |
|---|---|---|
| **Consolidation/enrichment** (the default flow) | Harness scheduler: section freezes → `enrich-section` → on success, `illustrate-section` (harness §6.1). One illustration per section, automatically. | scheduler-initiated (tail of the illustration lane) |
| **Staleness sweep** | A section whose `illustration_stale` flips (>15 % word delta, data-model §6.5) is re-illustrated by the idle sweep — *unless the current image is user-provided* (§6: `source: "user"` images are never auto-replaced). | scheduler-initiated |
| **User: illustrate/regenerate a section** | Section header menu → "Illustrate" / "Regenerate…" with an optional one-line guidance box ("show the storm from the cliff, dusk light"). Submits `illustrate-section` with `guidance`. | user-initiated (jumps the lane) |
| **User: world-entry image** | World editor → "Generate image" (+ optional guidance). Submits `world-image`. | user-initiated |

**Override paths** (all three ship in MVP — they are the safety valve that lets the automatic
loop stay simple):

1. **Regenerate with guidance** — same task, `guidance` string threaded into the composer
   (rule 6, §4.2). The old image stays in place until the new winner commits (atomic overwrite,
   data-model §13.5), so a failed regeneration never leaves a hole.
2. **Upload own image** — `PUT …/illustration` (multipart PNG/JPEG; JPEG is transcoded to PNG to
   keep the one-format-on-disk rule). Recorded with `source: "user"`, no run. Pinned: excluded
   from staleness sweeps until the user deletes or regenerates.
3. **Delete** — removes the PNG and nulls the enrichment metadata. The section then simply has no
   illustration; the sweep does **not** resurrect it (deletion sets `suppressed: true` in the
   metadata slot) — deleting an image the app keeps regenerating would be maddening. "Illustrate"
   in the menu clears the suppression.

The `guidance` field is an extension to the harness's `TaskSpec` (flagged in §13):

```ts
z.object({ kind: z.literal("illustrate-section"), sectionId: Ulid,
           guidance: z.string().max(500).optional() }),
z.object({ kind: z.literal("world-image"), entryId: Ulid,
           guidance: z.string().max(500).optional() }),
```

---

## 6. Storage: files, metadata, candidates

Everything user-visible follows the data-model layout; the pipeline writes only through
`StorageService`.

```
<work-dir>/
  manuscript/<NNN>-<slug>.<shortid>/
    illustration.png                 # the one committed image (atomic overwrite)
    section.json                     # enrichments.illustration = IllustrationMeta (below)
  world/
    images/<entryId>.png             # committed world-entry image
    images/<entryId>.json            # IllustrationMeta sidecar (world entries have no section.json)
  runs/<YYYY-MM>/<runId>.jsonl       # the FULL loop transcript: brief, composed prompts,
                                     #   per-attempt seed/score/critique JSON, timings, usage
```

`IllustrationMeta` extends the data-model's enrichment slot (its draft already carried `prompt`;
this is the fleshed-out version — flagged in §13):

```ts
export const IllustrationMeta = z.object({
  runId: Ulid.nullable(),            // null iff source === "user" (uploads have no run)
  source: z.enum(["agent", "user"]).default("agent"),
  generatedAt: IsoTime,
  sourceHash: Hash.nullable(),       // content.md hash it was generated from (staleness); null for world images
  prompt: z.string().nullable(),     // the winning composed prompt; null for uploads
  workflow: z.string().nullable(),   // registry name, e.g. "default"
  workflowHash: Hash.nullable(),     // ResolvedWorkflow.contentHash at generation time
  seed: z.number().int().nullable(),
  attempts: z.number().int().min(1).nullable(),   // rounds actually run
  score: z.number().min(0).max(10).nullable(),    // winner's critique score
  guidance: z.string().nullable(),
  suppressed: z.boolean().default(false),         // user deleted; sweep must not regenerate (§5)
});
```

This satisfies files-as-truth: a human reading `section.json` sees *what prompt, which workflow,
which seed, how many rounds, what score*; a human wanting the full story opens the run JSONL
named by `runId`. The `run_artifacts` index row (`kind: "illustration"`, data-model §7.1) links
image → run for the provenance UI with no new machinery.

**Candidates: discarded.** Only the winner is written; losing attempts survive as text (their
prompts, seeds, and critiques in the run file) but not as pixels. Rationale: images are the one
bulky artifact in the system, regeneration is <20 s and fully described by the recorded
prompt+seed+workflow (byte-identical reproduction on the same ComfyUI install), and "exactly one
illustration per section" is a data-model invariant. A candidate-picker UI ("choose from 3") is
structured-for — the loop already produces scored candidates in memory; persisting them to
`.cowrite/illustration-candidates/` and adding a picker is deferred (§12). *Rejected for MVP:*
keeping all candidates on disk (violates the one-image invariant, grows the work directory with
rejected art nobody chose).

---

## 7. Visual consistency without character-reference features

MVP has no IPAdapter/reference-image/img2img plumbing — consistency is **nudged textually**,
three ways, all already present in §4.2:

1. **Stable descriptions at the source.** World entries are the canonical place for appearance
   ("Appearance:" lines in the entry body are the documented convention); the composer receives
   matched entries' bodies and must render characters from them.
2. **Established-imagery reuse.** The composer is given the last accepted image prompts that
   mentioned the same entities and instructed to copy physical descriptions *verbatim* (§4.2
   rule 4). Because winning prompts are durably stored in `IllustrationMeta.prompt`, the
   vocabulary converges over time ("cropped grey hair, storm-lantern in hand" recurs) instead of
   drifting.
3. **One workflow, one style.** Routing every section through the same registered workflow keeps
   checkpoint/LoRA/style constant, which is most of what readers perceive as consistency; the
   critic's `consistency` axis (§4.3) catches the remainder against the brief's descriptions.

*Structured-for, deferred:* passing the world entry's existing image to the critic as a second
`image_url` for a true visual comparison, and reference-conditioning workflows (a registry entry
whose graph takes an image input) — the registry schema and marker convention leave room
(`%refimage%` is an obvious future marker), but multi-image VLM support and per-install ComfyUI
node availability are too uneven to bet the MVP on.

---

## 8. API surface and SSE progress

Task submission, cancellation, run retrieval, and the SSE channel are the harness's generic
endpoints (harness §8) — illustration adds no parallel task API. This subsystem contributes:

| Method & path | Purpose | Notes |
|---|---|---|
| `GET /api/illustration/health` | ComfyUI reachability + registry validation report | `{ ok, comfy: {ok, detail}, workflows: [{name, label, ok, error?}] }`; powers a settings-page status row |
| `GET /api/illustration/workflows` | registry list for future pickers | name + label only |
| `PUT /api/works/:workId/sections/:sectionId/illustration` | user upload (multipart) | transcode to PNG; writes `source:"user"` meta |
| `DELETE /api/works/:workId/sections/:sectionId/illustration` | delete + suppress (§5) | idempotent |
| `PUT /api/works/:workId/world/:entryId/image` | upload for world entry | same semantics |
| `DELETE /api/works/:workId/world/:entryId/image` | delete + suppress | idempotent |

Images are served by the API layer's static work-file route (assumption §13); the UI cache-busts
with `generatedAt`.

**What the UI sees during a run.** The pipeline emits one additional `TaskEvent` variant on the
task's existing SSE stream (extension flagged in §13):

```ts
z.object({
  type: z.literal("pipeline"),
  phase: z.enum(["composing", "submitting", "queued", "generating",
                 "critiquing", "revising", "committing"]),
  attempt: z.number().int().min(1),
  maxAttempts: z.number().int(),
  pct: z.number().min(0).max(1).nullable(),   // ComfyUI progress.value/max during "generating"
})
```

The section's image slot renders a shimmer with a caption cycling
`Composing prompt → Generating (attempt 2/3, 64 %) → Critiquing…`, then swaps in the committed
PNG on the terminal `artifact` + `done` events. Intermediate candidate images are **not**
streamed (no temp-image endpoint in MVP; the phases keep the run legible without pixels —
deferred, §12). Failures surface as the harness `error` event with code `pipeline` and a
`detail` the image slot renders as a badge (harness §11).

---

## 9. Module layout

```
apps/server/src/illustration/
  index.ts               # IllustrationPipeline: runSectionIllustration / runWorldImage (harness §13.5)
  loop.ts                # §4.1 round loop, best-of selection, guard rails
  composer.ts            # intent-brief assembly + compose/revise low-model calls (§4.2)
  critic.ts              # VLM critique call, CritiqueResult parsing + repair (§4.3)
  comfy/
    client.ts            # ComfyClient: submit / ws-track / history-poll / view / interrupt (§2.3)
    inject.ts            # marker scan + pure inject() (§2.2)
    registry.ts          # config load, workflow validation, ResolvedWorkflow cache (§3)
  routes.ts              # Fastify plugin: table in §8 (health, workflows, upload, delete)
  __tests__/
prompts/
  illustrate-compose.md  illustrate-revise.md  illustrate-critique.md   # wording owned by 07-prompting
packages/shared/src/
  illustration.ts        # ComfyConfig, WorkflowEntryConfig, IllustrationMeta, CritiqueResult,
                         #   pipeline TaskEvent variant
packages/mock-llm/src/
  comfy.ts               # mock ComfyUI server (§11)
  scenarios/comfy-*.json
```

The pipeline entry points match the harness contract exactly
(`RunContext = { lowClient, emit(RunEvent), signal }`); `loop.ts`, `inject.ts`, `composer.ts`
brief-building, and `critic.ts` parsing are pure or dependency-injected and unit-testable without
HTTP.

---

## 10. Failure modes

| Failure | Behavior |
|---|---|
| ComfyUI unreachable | Health gate: scheduler tasks fail quietly to the activity log (staleness badge stays); user tasks get `pipeline`/`comfy_unreachable` toast + retry. No retries against a dead box beyond the submit retry pair. |
| `POST /prompt` → 400 node errors | `workflow_invalid`, non-retryable; error detail names the failing node; also caught earlier by startup registry validation. |
| `execution_error` mid-job | Retried **once** with the same prompt + fresh seed (transient VRAM OOM is common); second failure fails the *attempt*. If it was attempt 1 of N, the loop still tries remaining attempts (a systematic error will fail them fast and the run ends `pipeline` with the ComfyUI exception message). |
| WS drops / silent | Transparent fallback to `/history` polling every 2 s (§2.3); progress degrades to phase-only (pct null). Never fails a job by itself. |
| Queue/exec timeout | Interrupt/dequeue our job, fail the attempt → same policy as `execution_error`. |
| VLM critique unparseable | One repair retry; then neutral score `{revise, 5}` — the loop proceeds; never wedges. |
| Composer emits tag-less/overlong output | Harness tag-block repair turn covers the `<image-prompt>` block; >150-word prompts are passed through with a logged warning (diffusion encoders truncate gracefully). |
| Task aborted (cancel / work close) | `signal` propagates: interrupt ComfyUI, drop in-memory candidates, run ends `cancelled`; the previous committed image is untouched (commit is the only write). |
| Image bytes huge / not PNG | 32 MB cap on `/view` reads; non-PNG output from exotic save nodes is transcoded via sharp, failure ⇒ attempt fails. |
| Server crash mid-run | Harness startup finalizer marks the run `crash`; no partial files exist (memory-only candidates, atomic commit). Section keeps old image; staleness re-queues it. |
| Same section re-illustrated while stale sweep queued | Harness lane dedupe by `(kind, targetId)` (its §6.1) — no duplicate jobs. |

---

## 11. Mock ComfyUI server and test plan

`packages/mock-llm/src/comfy.ts` — a Fastify + `ws` server implementing the §2.1 surface, driven
by the same ordered-scenario mechanism as mock-llm (unmatched request ⇒ loud test failure):

```ts
export const MockComfyStep = z.object({
  match: z.object({ promptIncludes: z.string().optional() }).default({}),
  respond: z.discriminatedUnion("type", [
    z.object({ type: z.literal("image"),
               fixture: z.string().default("gradient.png"),
               queueMs: z.number().default(0), execMs: z.number().default(50),
               progressTicks: z.number().default(4),
               embedPromptText: z.boolean().default(true) }), // writes the injected prompt into a
                                                              // PNG tEXt chunk so tests can assert
                                                              // injection end-to-end from the bytes
    z.object({ type: z.literal("rejectSubmit"), nodeErrors: z.record(z.string(), z.unknown()) }),
    z.object({ type: z.literal("executionError"), nodeId: z.string(), message: z.string() }),
    z.object({ type: z.literal("dropWs") }),                  // kill the socket mid-run → polling path
    z.object({ type: z.literal("hang"), forMs: z.number() }), // exercise queue/exec timeouts
  ]),
});
```

It honors `POST /interrupt` and `POST /queue{delete}` (emitting `execution_interrupted`), serves
`/system_stats`, `/history/:id`, `/view`, and streams the standard message sequence over `/ws`.
`pnpm mock:comfy` runs it standalone on `:8188` with an always-succeed scenario so the whole app
demos offline (harness §12 tier 3).

**Test tiers** (mirroring the harness):

1. **Unit:** `inject.ts` marker scan + injection (property: output graph differs from template
   only at mapped fields; template never mutated); registry validation matrix (missing `%prompt%`,
   duplicate `%prompt%`, missing `%seed%`, ambiguous outputs); `CritiqueResult` parse/repair;
   best-of selection math (regression case: scores `[7?no—use 6,8,4]` picks attempt 2; early
   accept stops the loop).
2. **Integration (Vitest, real Fastify + mock-comfy + mock-llm low lane):** golden scenarios —
   `illustrate-accept-first` (1 attempt, early accept), `illustrate-revise-then-accept`,
   `illustrate-best-of-three` (no accept; asserts committed PNG is the top-scored fixture via the
   tEXt-embedded prompt), `comfy-400-invalid`, `exec-error-then-ok` (retry-once path),
   `ws-drop-poll-fallback`, `hang-exec-timeout`, `cancel-mid-generate` (asserts `/interrupt`
   received + no file written), `world-image-happy`, `upload-then-sweep-skips` (user image never
   auto-replaced), `delete-suppresses`. Each asserts: SSE `pipeline` event sequence, run-file
   `RunEvent`s (Zod-parsed), `IllustrationMeta` on disk, index `run_artifacts` row.
3. **E2E (Playwright):** press "Illustrate" on a chapter → shimmer with phase captions → image
   appears; "Regenerate…" with guidance → new image + provenance view shows the guidance and
   critique transcript.

---

## 12. MVP cut

**Ships first (M1):**

- ComfyClient (submit / WS progress / history / view / interrupt), polling fallback, timeout
  ladder, health check + startup registry validation
- `%marker%` node-title convention with `%prompt%` + `%seed%` required, `%output%`
  disambiguation; single `default` workflow; registry structure supporting many
- Full agentic loop: composer (natural-language, no-tags rules), 3-attempt critique/revise,
  best-of selection with early accept; text-only consistency nudges (§7)
- `illustrate-section` + `world-image` including scheduler triggers, guidance on regenerate,
  upload, delete-with-suppression
- `IllustrationMeta` on disk + full transcript in run files; candidates discarded
- SSE `pipeline` progress events; health/upload/delete routes; mock ComfyUI + golden scenarios

**Structured-for, deferred:**

- Multiple workflows routed per kind / per-task workflow picker UI (registry + `route` config
  already support it; UI later)
- `%width%`/`%height%` actually varied (markers mapped now; e.g. portrait aspect for world
  entries later)
- Candidate persistence + "pick from N" UI; interim candidate previews over SSE
- Reference-image consistency (`%refimage%` marker, world image passed to the critic)
- Batch back-illustration ("illustrate all un-illustrated chapters") — trivially a loop over the
  existing task, but it's surprise GPU-hours; wants a confirm UI
- ComfyUI queue-position display from `status` messages (nice, not needed)

---

## 13. Interface assumptions (cross-check with sibling designs)

1. **Agent harness (05):** the pipeline implements
   `runSectionIllustration(sectionId, ctx)` / `runWorldImage(entryId, ctx)` with
   `RunContext = { lowClient: LlmClient, emit(RunEvent), signal: AbortSignal }` exactly as its
   §13.5 assumes; the harness owns the illustration lane (capacity 1 global, user jumps
   scheduler), the 10-minute total timeout, run persistence, and error surfacing (`pipeline`
   code). **Extensions needing sign-off:** (a) optional `guidance: string(≤500)` on the
   `illustrate-section` / `world-image` `TaskSpec` variants (§5); (b) a new `pipeline` variant in
   the `TaskEvent` SSE union (§8); (c) the low `LlmClient` must accept `image_url` content parts
   on chat messages (already implied by its §3.2 routing rule).
2. **Storage / data model (02):** `writeEnrichment(sectionId, "illustration", png, meta)`
   performs the atomic one-image-per-section overwrite (its §13.5). **Extensions:**
   (a) `IllustrationMeta` (§6) supersedes the draft `EnrichmentMeta.extend({prompt})` in
   data-model §10 — adds `source`, nullable `runId` (user uploads), `workflow(+hash)`, `seed`,
   `attempts`, `score`, `guidance`, `suppressed`; (b) a world-image variant writing
   `world/images/<entryId>.png` **plus a sidecar `<entryId>.json`** holding the same meta (world
   entries have no section.json slot); (c) read queries: `matchWorldEntries(text) →
   WorldEntry[]` (a `world_keys` scan, listed in its §7.2), and `listIllustrationMetas(workId)`
   for the established-imagery input (§4.2); (d) the staleness sweep must skip
   `source === "user"` and `suppressed === true` illustrations (§5, §6).
3. **Context engine (06):** deliberately **not used** — illustration runs with zero planning
   rounds and assembles its own small intent brief from storage reads (§4.2), so no context
   session, ledger elevation, or decay is involved. The engine's `enrichment_wanted` event is
   unrelated to this subsystem.
4. **Prompting (07):** owns the literal wording of `prompts/illustrate-{compose,revise,critique}.md`;
   this doc fixes the composer's content rules (§4.2), the `<image-prompt>` output block, and the
   `CritiqueResult` JSON contract (§4.3).
5. **API layer (03):** mounts `illustration/routes.ts` under `/api`; provides multipart body
   support for the two upload routes and a static work-file route that serves
   `illustration.png` / `world/images/*.png` to the UI (cache-busted by `generatedAt`).
6. **Config (03/overview):** `cowrite.config.json` tolerates the `comfyui` block (§3) with
   `${env:VAR}` interpolation unused here (ComfyUI has no auth); like model endpoints, a missing
   `comfyui` block must not crash the app — illustration features render as "not configured".
7. **Frontend (04):** implements the image-slot shimmer with `pipeline` phase captions, the
   regenerate-with-guidance popover, upload/delete affordances, the settings-page health row
   (`GET /api/illustration/health`), and the provenance view already planned for runs (critique
   transcripts appear there for free).
8. **Testing (09):** `packages/mock-llm` hosts the mock ComfyUI (`src/comfy.ts`) alongside the
   mock LLM so all three tiers share one fixture story, per the harness's §12 layout.

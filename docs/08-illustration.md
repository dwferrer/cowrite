# 08 — Illustration Pipeline (ComfyUI + VLM Feedback Loop)

This document specifies how Cowrite turns "this section deserves a picture" into a committed
`illustration.png` (or `world/images/<entryId>.png`): a low-model **composer** that writes a
natural-language image prompt from the section's text and relevant world-info; a **ComfyUI
client** that injects that prompt into a user-supplied workflow and retrieves the image; a
low-VLM **critic** that scores the result against the intent; and a bounded, budget-aware
revise-and-regenerate loop that commits the best attempt. It covers the ComfyUI API integration,
the workflow registry and its config schema, the agentic loop, on-disk metadata, the HTTP/SSE
surface, failure modes, and the mock server + test plan.

## Key decisions

- **Node-title `%marker%` injection convention** — marked workflows stay loadable and editable
  inside ComfyUI itself, and the injection mapping is derived from the file, never hand-written.
- **`/history` is truth, the websocket is progress** — a dropped socket degrades to polling and
  never fails a job.
- **One bounded critique loop on the low VLM, best-of commit with early accept** — quality comes
  from agentic feedback, not workflow knobs, and a scored winner is never thrown away.
- **Budget-aware attempts** — the loop checks the harness's remaining time budget before each
  attempt and commits the best-scored candidate when budget or attempts run out.
- **Winner-only persistence, full transcript in the run JSONL** — files stay the truth without
  filling the work directory with rejected art; any attempt is reproducible from its recorded
  prompt + seed + workflow hash.
- **Consistency by text, keyed by entity id** — established-imagery reuse looks up prior winning
  prompts by the world-entry ids recorded at compose time; no reference-image plumbing in MVP.
- **Three-state illustration slot** (absent / present / tombstone) — a deleted image is never
  resurrected by the staleness sweep.
- **Registry errors are per-workflow and task-time** — a broken or dangling workflow surfaces as
  `config_missing` when used, never as a failed boot.
- **Guest of the agent harness** — no parallel task API; the pipeline runs inside a harness-owned
  run via `RunContext` (05 §illustration handoff).

Latency is stated as an explicit assumption of this design, not a product requirement: one image
generation is assumed to take **10–90 s** depending on the user's GPU and workflow (first-run
checkpoint loads can add a minute). All timeouts below are config with generous defaults, and the
loop's budget awareness (§4.4) makes the worst case degrade to "fewer attempts", never to "no
image".

---

## 1. Scope and principles

1. **The workflow is the user's.** Cowrite never edits, generates, or understands diffusion
   graphs. The user exports an API-format workflow from their own ComfyUI, marks the injection
   points, and drops the file in a folder. All style, samplers, checkpoints, LoRAs, negative
   prompts, and resolution live in that file.
2. **The pipeline is a guest of the agent harness.** It executes inside a harness-owned run
   (`illustrate-section` / `world-image` tasks): the harness owns the queue slot, the abort
   signal, the total time budget, and the run record; the pipeline emits `RunEvent`s and
   `task.progress` through the provided `RunContext` and commits artifacts only through
   `StorageService`.
3. **Agentic quality, not parameter quality.** Better images come from the critique loop, not
   from exposing CFG sliders.
4. **Files are the truth.** The winning PNG plus its generation metadata land in the work
   directory in human-readable form; the full loop transcript (prompts, critiques, seeds,
   timings) is the run's JSONL file. Nothing about an illustration is app-private.
5. **Test without models or GPUs.** Every behavior in this doc runs against the mock low model
   and the mock ComfyUI server (§11, 09-testing.md).

Out of scope: task queueing/retries at the harness level (05-agents.md), where sections and
their staleness come from (02-data-model.md), context assembly for prose tasks
(06-context-engine.md), and prompt template wording (07-prompting.md).

---

## 2. ComfyUI API integration

### 2.1 Endpoint surface used

Exactly the stable, documented subset of ComfyUI's HTTP/WS API. Nothing else.

| Endpoint | Use |
|---|---|
| `POST /prompt` | Submit a job. Body `{ prompt: <api-format workflow JSON>, client_id }` → `200 { prompt_id, number, node_errors }`; `400` with per-node errors for an invalid graph. |
| `WS /ws?clientId=<uuid>` | Progress stream: `status`, `execution_start`, `execution_cached`, `executing` (`data.node === null` ⇒ job finished), `progress {value, max}`, `executed {output.images}`, `execution_error`, `execution_interrupted`. Binary preview frames are ignored in MVP. |
| `GET /history/<prompt_id>` | Authoritative result record: `outputs[<nodeId>].images: [{filename, subfolder, type}]` + terminal status. Used at completion and as the polling fallback when the WS is unhealthy. |
| `GET /view?filename=&subfolder=&type=` | Fetch the PNG bytes. |
| `GET /system_stats` | Health check (cheap; returns versions + device info). |
| `POST /interrupt` | Cancel the currently executing job (on task abort or budget exhaustion). |
| `POST /queue` `{ delete: [prompt_id] }` | Remove our job if it is still queued when we abort. |

`client_id` is one UUID minted per server process at boot; WS messages are correlated by
`prompt_id`, so a stable client id is only needed to receive the stream at all.

### 2.2 Injection points: the `%marker%` node-title convention

The user designates injection points by **renaming nodes in the ComfyUI GUI** so the node title
contains a marker token, then exporting with "Save (API format)". In API-format JSON the title
survives as `_meta.title`:

```jsonc
// ~/.cowrite/workflows/default.json (user-supplied, abridged)
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
| `%output%` | none (selector only) | marks which node's images to collect | see output-node rule below |

**User setup.** Marking node titles (`%prompt%`, `%seed%`, and usually `%output%`) is the **one
manual step** a user must perform on their workflow file before Cowrite can use it — everything
else is drop-in. The first-run/setup documentation must surface this step prominently; 03 §9.4's
ComfyUI setup card links here.

**Why node-title markers**: titles are cosmetic to ComfyUI's executor, so a marked workflow
**remains loadable, editable, and runnable inside ComfyUI itself** — the user iterates on their
graph in the GUI, re-exports, and the markers ride along; no hand-editing of JSON, no side-car
mapping file to drift out of sync, and validation reduces to a title scan. *Rejected:*
placeholder strings inside input values (e.g. the text field literally containing `%prompt%`) —
works for strings but not for numeric fields like `seed`/`width` without producing JSON that
ComfyUI can no longer load; a hand-written node-id → field mapping in config — node ids are
unstable across graph edits and the mapping silently rots; auto-detecting "the"
`CLIPTextEncode`/`KSampler` — ambiguous the moment a workflow has a negative prompt or a refiner
stage, and silent guessing is how wrong images happen.

**Output-node rule.** API-format JSON describes node classes and inputs, not outputs, so "which
node produces the image" is not derivable from the graph in general. The rule is therefore
explicit:

- The workflow **should** mark its output node with `%output%` in the title. That marker always
  wins.
- **Fallback when absent:** exactly one node whose `class_type` is in the built-in whitelist
  `["SaveImage", "PreviewImage"]` — that node is the output. Zero or multiple whitelist matches
  (custom save nodes, multi-branch graphs) ⇒ per-workflow **registry validation error** whose
  message says to add `%output%`.
- **Runtime backstop:** if `history.outputs[outputNodeId]` has no images but exactly one other
  node in the history record does, use it and log a warning — a user's custom save node then
  works instead of failing, while the log points at the missing marker.

**Validation** (at registry load, §3, re-checked before each submit):

- exactly one `%prompt%` node, and it has a string `text` input → else invalid ("mark exactly
  one text-encode node with %prompt%");
- ≥ 1 `%seed%` node with an integer `seed`/`noise_seed` input → else invalid. A seed marker is
  mandatory because the loop's whole mechanism is re-rolling: without seed injection every
  attempt would render the identical image (API-format executes the embedded seed as-is, and
  ComfyUI's result cache would short-circuit repeats via `execution_cached` anyway);
- an output node resolvable by the rule above.

Validation failures are **recorded per workflow** in the registry (surfaced via
`GET /api/illustration/health` and as task-time `409 config_missing` when the broken workflow is
routed to) — never startup-fatal (03 §config).

Seeds are drawn as uniform integers in `[0, 2^53)` (`crypto`), recorded per attempt.

### 2.3 The `ComfyClient`

```ts
// apps/server/src/illustration/comfy/client.ts
export interface ComfyProgress {
  phase: "queued" | "generating";
  pct: number | null;              // progress.value/max × 100 while a sampler runs
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
    deadlineMs: number;                  // hard ceiling for this call (min of timeouts and remaining budget)
    signal: AbortSignal;
    onProgress: (p: ComfyProgress) => void;
  }): Promise<ComfyResult>;
}
```

`generate` algorithm:

```
generate(req):
  ensure ws connected (shared, lazy, auto-reconnect; clientId = process UUID)
  { prompt_id } = POST /prompt { prompt: req.workflow, client_id }     # 400 ⇒ WorkflowInvalidError(node_errors)
  deadline_queue = now + queueTimeoutMs        # job may sit behind the user's own ComfyUI jobs
  deadline_exec  = null
  deadline_hard  = now + req.deadlineMs        # budget ceiling; always enforced
  loop:
    ev = next ws message for prompt_id, OR 2 s tick
    on execution_start:            deadline_exec = now + execTimeoutMs; onProgress(generating, null)
    on progress:                   onProgress(generating, 100 * value/max)
    on executing(node == null) or executed or execution_cached-terminal:
                                   break → fetch
    on execution_error:            throw ComfyExecError(node_id, node_type, exception_message)
    on execution_interrupted:      throw Aborted
    on tick:
      if ws silent > wsFallbackMs (10 s) or ws down:
          h = GET /history/prompt_id                                    # polling fallback, every 2 s
          if h.completed: break → fetch
          if h.status == error: throw ComfyExecError(from h.messages)
      if any deadline passed:      POST /interrupt (if executing) / POST /queue{delete}; throw Timeout
    on req.signal aborted:         POST /interrupt or /queue{delete}; throw Aborted
  fetch:
    h = GET /history/prompt_id                                          # /history is truth, ws is progress
    img = h.outputs[req.outputNodeId].images[0]
          # missing ⇒ runtime backstop (§2.2): the unique other node with images, warn
          # >1 image ⇒ take [0], log warning
    png = GET /view?filename&subfolder&type
    return { png, filename, durationMs, promptId }
```

Design points: **`/history` is the source of truth, the websocket is only progress** — a dropped
WS never fails a job, it just degrades to 2-second polling with phase-only progress. Submission
network errors are retried twice (1 s → 4 s backoff); an `execution_error` is **not** blindly
retried by the client — the pipeline layer decides (§10), because a bad graph fails forever while
a VRAM OOM is transient.

### 2.4 Timeouts and health (defaults; all under `comfyui.timeouts` except `illustrationBudgetMs`, which lives under `config.harness`)

| Knob | Default | Rationale |
|---|---|---|
| `healthTimeoutMs` | 3 000 | `/system_stats` is instant when the box is up |
| `connectTimeoutMs` | 5 000 | submit + view fetches; localhost or LAN |
| `queueTimeoutMs` | 120 000 | our job may sit behind the user's own ComfyUI jobs |
| `execTimeoutMs` | 300 000 | covers the pessimistic end of the 10–90 s assumption plus first-run checkpoint load; per-workflow override for slower graphs (§3) |
| `wsFallbackMs` | 10 000 | WS silence before switching to `/history` polling |
| `illustrationBudgetMs` | 600 000 | whole run, **owned by the harness** (`config.harness`, 05 §6.4 — not `comfyui.timeouts`); the pipeline reads it via `RunContext.remainingMs()` and self-limits (§4.4) |

The per-attempt timeouts and the run budget are decoupled on purpose: timeouts bound *one hung
call*, the budget bounds *the whole loop*, and §4.4's budget checks reconcile them so the harness
never has to kill the run from outside.

**Health check.** `GET /system_stats` runs (a) at app start, (b) lazily before each pipeline run,
cached 60 s, (c) on demand via `GET /api/illustration/health` (§8) and
`POST /api/config/test {target: "comfyui"}` (03 §config). Unreachable ⇒ scheduler-initiated tasks
fail quietly (run recorded, staleness badge stays); user-initiated tasks surface `task.failed`
with code `pipeline` and detail `comfy_unreachable`, rendered with a retry button.

---

## 3. Workflow registry

Named workflows live in **app config** (not per work — they describe the user's ComfyUI install,
not a story): the `comfyui` block of `~/.cowrite/config.jsonc`, with workflow JSON files in
`~/.cowrite/workflows/` by default (03 §config layout).

```jsonc
// ~/.cowrite/config.jsonc (the comfyui block)
{
  "comfyui": {
    "baseUrl": "http://127.0.0.1:8188",
    // "workflowsDir": "…",            // default: <configDir>/workflows
    "workflows": {
      "default": { "file": "default.json", "label": "Default (SDXL scene)" }
      // later: "portrait": { "file": "portrait.json", "label": "Portrait crop" },
      //        "hq":       { "file": "hq.json", "label": "Hi-res 2-pass", "execTimeoutMs": 600000 }
    },
    "route": { "section": "default", "world": "default" },   // which named workflow per image kind
    "loop": { "maxAttempts": 3, "acceptScore": 7 },          // §4
    "timeouts": { /* §2.4 overrides */ }
  }
}
```

```ts
// packages/shared/src/illustration.ts (owned by this subsystem; 03 §config embeds ComfyConfig)
export const WorkflowEntryConfig = z.object({
  file: z.string().min(1),                       // relative to workflowsDir
  label: z.string().min(1),
  execTimeoutMs: z.number().int().positive().optional(),  // per-workflow override (hq graphs are slower)
});

export const IllustrationTimeouts = z.object({
  healthTimeoutMs:  z.number().int().positive().default(3_000),
  connectTimeoutMs: z.number().int().positive().default(5_000),
  queueTimeoutMs:   z.number().int().positive().default(120_000),
  execTimeoutMs:    z.number().int().positive().default(300_000),
  wsFallbackMs:     z.number().int().positive().default(10_000),
});

export const ComfyConfig = z.object({
  baseUrl: z.url(),
  workflowsDir: z.string().optional(),           // default resolves to <configDir>/workflows
  workflows: z.record(z.string().regex(/^[a-z0-9-]+$/), WorkflowEntryConfig).default({}),
  // zod 4: a nested-object default must be a COMPLETE output object, so `.default({})` on an
  // object whose members have their own `.default(...)` mis-types; `.prefault({})` feeds `{}`
  // through the child parse instead, materializing the full effective object (see config.ts).
  route: z.object({
    section: z.string().default("default"),
    world:   z.string().default("default"),
  }).prefault({}),
  loop: z.object({
    maxAttempts: z.number().int().min(1).max(6).default(3),
    acceptScore: z.number().min(0).max(10).default(7),
  }).prefault({}),
  // `.prefault({})` (not `.partial().default({})`): zod 4 re-materializes defaults under
  // `.partial()`, and these ARE the effective defaults, so prefault keeps the wire semantics.
  timeouts: IllustrationTimeouts.prefault({}),
});
```

Deliberately **no cross-field Zod refinement** ties `route` to `workflows`: an invalid config
file is startup-fatal (03 §config), and a dangling route name or a broken workflow file must
never be. Instead the **registry load** (startup, config reload) checks per entry:

- each `workflows.*.file` exists, parses as API-format JSON, and passes the §2.2 marker
  validation → per-workflow `{ ok, error? }` record;
- each `route.*` names an existing, valid workflow → per-route error record otherwise.

Every finding surfaces in `GET /api/illustration/health` and, when a broken/dangling workflow is
actually routed to by a task, as `409 config_missing` at task creation — the same code and UI
treatment as an unconfigured model lane (05 §errors). A `null`/absent `comfyui` block simply
renders illustration features as "not configured" (first-run setup card three is skippable,
03 §first-run). In Docker, env vars configure only `COWRITE_COMFYUI_BASE_URL`; workflow files
require the config volume (`-v ~/.cowrite:/root/.cowrite`, 03 §deployment).

```ts
// resolved at load time (apps/server/src/illustration/comfy/registry.ts)
export interface ResolvedWorkflow {
  name: string;                                  // registry key, e.g. "default"
  label: string;
  json: Record<string, unknown>;                 // parsed API-format graph (frozen template)
  injections: {
    promptNodeId: string;                        // the %prompt% node
    seedNodeIds: string[];                       // all %seed% nodes
    widthNodeId?: string; heightNodeId?: string; // mapped, unused in MVP
    outputNodeId: string;                        // %output%, or the unique whitelisted class (§2.2)
  };
  execTimeoutMs: number;                         // entry override or timeouts default
  contentHash: string;                           // for run metadata / change detection
}
```

Injection mappings are **derived from the markers, never hand-written** — the marker scan *is*
the mapping. Injection itself is a pure function:
`inject(resolved, { prompt, seed }) → deep-cloned graph JSON` (unit-tested in isolation, §11).

**MVP ships with the structure above and exactly one entry, `default`, used for both `section`
and `world` routes.** The user can add `"portrait"`, `"hq"`, etc. and repoint `route` in config —
no UI for choosing workflows per task in MVP (a fiddly knob; the config file is the power-user
surface). Cowrite ships a **sample** `default.json` (a plain SDXL txt2img graph with markers
applied) as documentation, but the user is expected to replace it with a workflow matching their
own install — we cannot know their checkpoints.

---

## 4. The agentic loop (composer → generate → critic)

Both task kinds run the same loop; they differ only in how the *intent brief* is built:

- `illustrate-section` → intent from the section (title, summary/content, matched world entries);
- `world-image` → intent from the world entry (name, body).

The loop runs on the **low model** (the VLM) via `ctx.lowClient` — the pipeline drives its own
calls and records them as run events. The high model is never involved and never sees images
(05 §routing).

### 4.1 Round structure

```
runIllustration(intent, workflow, guidance?, ctx):
  brief   = buildIntentBrief(intent, guidance)               # §4.2; recorded as a run message
  prompt  = compose(ctx.lowClient, brief)                    # low-model call #1 (text only)
  scored  = []                                               # successful, critiqued attempts
  lastErr = null
  for n in 1..maxAttempts:                                   # default 3
      if n > 1 and ctx.remainingMs() < attemptEstimateMs():  # budget gate, §4.4
          break
      ctx.progress(phase per step, attempt n, maxAttempts)
      seed = randSeed()
      img  = try comfy.generate(inject(workflow, {prompt, seed}),
                                deadlineMs = min(timeouts, ctx.remainingMs() - commitMarginMs))
      if img failed:                                         # §10 per-attempt policy
          lastErr = error; continue                          # slot consumed; prompt carries over
                                                             #   unchanged; no critique, no revise
      crit = critique(ctx.lowClient, downscale(img.png), brief, prompt)   # §4.3
      scored.push({ n, prompt, seed, score: crit.overall, crit, png: img.png })
      if crit.verdict == "accept" and crit.overall >= acceptScore: break  # the only accept rule
      if n < maxAttempts:
          prompt = revise(ctx.lowClient, brief, prompt, asRevise(crit))   # §4.3 coercion
  if scored is empty: fail(code "pipeline", detail from lastErr)
  winner = argmax(scored, by score, tie → latest attempt)    # best-of, §4.5
  ctx.progress(committing)
  commit(winner)                                             # storage write, §6
```

**`maxAttempts` default 3** (1 initial + up to 2 revisions). Empirically the first revision fixes
most misses ("the dragon is missing", "wrong hair colour") while a second revision mostly
re-rolls variance — beyond that you are paying latency for noise. Under the 10–90 s generation
assumption, 3 attempts put the run anywhere from ~30 s to several minutes; the budget gate keeps
the pessimistic end from overrunning. Configurable 1–6 via `comfyui.loop.maxAttempts`; `1`
degrades gracefully to generate-once (the critique still runs once to record a score).

A **failed attempt consumes a slot**: the prompt carries over unchanged (no critique exists to
revise from), and a fresh seed is enough to dodge transient failures. Two consecutive
`execution_error`s within one attempt (§10) fail that attempt; if every attempt fails, the run
fails with the last ComfyUI error message.

### 4.2 Prompt composition (the composer)

**Inputs to the intent brief** (all plain storage reads — no context-engine session, no ledger):

| Input | Source | Cap |
|---|---|---|
| Section title + **long summary**; fallback when no summary exists: `content.md` truncated to the first ~1 000 + last ~2 000 tokens with a `[…]` marker between (biases toward the setup and the climax rather than one end) | enrichment files / section content (02) | ~3 000 tokens |
| Matched world entries: full bodies of entries whose `keys` occur in the section text | `matchWorldEntries(text)` (02 §StorageService; key scan whose consumer is this pipeline) | 4 entries, ~400 tokens each, most-mentioned first |
| **Established imagery**: winning prompts of previous illustrations whose recorded `entities` intersect the matched entry ids (§7) | `listIllustrationMetas()` filtered by entity id, newest first | last 3 |
| Optional user guidance (regenerate path, §5) | task spec | 500 chars |

Using `keys` to pick the matched world entries is a deliberate, scoped exception to the brief's
rule that keys are not used for choosing what context to send to the model: it applies only to
this low-model illustration/enrichment path, never the high-model writing path, where the
context engine owns inclusion (05 §task kinds).

The scheduler orders `enrich-section` before `illustrate-section` (05 §scheduler), so the long
summary normally exists; the fallback covers user-forced early illustration. For `world-image`,
the brief is the entry's name + body, `entities = [entryId]`, and established imagery for that
entity.

The brief is rendered in the standard prompt markup — instructions at the top, the target
material at the bottom, tag grammar and template wording per 07-prompting.md
(`prompts/illustrate-compose.md`). Region ordering:

```
<instructions>            # composer rules below
<world-info>              # matched entries, full bodies
<established-imagery>     # prior winning prompts for shared entities
<guidance>                # user guidance, when present
<target>                  # section title + long summary (or truncated content)
```

**Output contract** — one `<image-prompt>` output block (block-per-kind table in 05 §output
contracts; tag grammar in 07), containing a **single natural-language descriptive paragraph,
60–120 words**. The composer's content rules (fixed here; wording owned by 07):

1. Pick **one concrete visual moment** from the section — a single scene, not a montage.
2. Write flowing descriptive prose: subject first, then action, setting, lighting, mood, and
   framing (e.g. "wide shot", "close portrait"). Present tense.
3. **No tag soup, no quality boilerplate, no negative prompts, no artist names, no resolution
   incantations** ("masterpiece, 8k, trending" is banned). Style and negatives belong to the
   user's workflow; the prompt describes *content only*. This is what makes one prompt portable
   across every registered workflow.
4. **Reuse established imagery verbatim**: when a character or place appears in the
   established-imagery list, copy its physical description word-for-word rather than
   re-describing it (§7).
5. Never include names the image model can't ground: render "Mara Voss" as her physical
   description ("a weathered woman in her forties with cropped grey hair…"), optionally keeping
   the name *after* the description ("— Mara —" is allowed but decorative).
6. If user guidance is present it wins over everything except rule 3.

Composer and reviser are plain text-only low-model calls (~1–2 s), recorded as `message` +
`output` run events. At compose time the pipeline records the matched world-entry ids into the
eventual `IllustrationMeta.entities` (§6) — this is what keeps rule 5 (no names in prompts) from
defeating the established-imagery lookup, which works by id, never by text-matching prompts.

### 4.3 The critic (VLM critique)

One low-model call per successful attempt with the generated image attached as an `image_url`
part (base64 data URL — the only place in Cowrite where a model receives an image, permitted
only on the low lane per 05 §routing). Before attaching, the PNG is **downscaled with `sharp` to
≤ 768 px on the longest side** — a 0–5 rubric judgement doesn't need native resolution, and this
shrinks the request body ~4×, which matters for small self-hosted endpoints with modest body
limits. The critic sees: the intent brief, the exact prompt used, and the image. It returns JSON
(Zod-parsed from a fenced block; one repair retry on parse failure, then treat as
`{ verdict: "revise", overall: 5 }` so a flaky critic never wedges the loop):

```ts
// packages/shared/src/illustration.ts
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

**One accept rule, no dead zone**: the loop stops early iff
`verdict === "accept" && overall >= acceptScore` (§4.1). Every other outcome is treated as a
revise — `asRevise(crit)` coerces the verdict and, when `promptAdvice` is empty or blank (an
agreeable small VLM saying "accept, 6.5" with nothing actionable), substitutes
`problems.join("; ")`, or failing that a stock instruction ("keep the same moment; re-assert any
listed elements; simplify the composition"). The reviser is therefore never steered on nothing.

The rubric is deliberately four axes and no more: each axis maps to a failure the reviser can
act on (add the missing subject; re-assert a description; simplify the scene to reduce
artifacts; adjust lighting/palette words). The full critique JSON is recorded as a `toolCall` run
event (`name: "vlm.critique"`), so the provenance view replays the whole conversation — **the
critique transcript is the run file**, by design; no separate transcript artifact.

### 4.4 Budget awareness

The harness gives the run `illustrationBudgetMs` (default 600 000 ms) and exposes the remainder
via `RunContext.remainingMs()` (05 §illustration handoff). The pipeline self-limits so the
harness never has to kill it:

- **Before each attempt after the first**: skip to commit unless
  `remainingMs() > attemptEstimateMs()`, where `attemptEstimateMs` = 1.5 × the slowest completed
  attempt so far (generate + critique + revise), floored at 30 s. Observed durations beat
  pessimistic timeout sums — a fast box gets all its attempts, a slow one degrades to fewer.
- **Within an attempt**: `generate`'s `deadlineMs` is capped at
  `remainingMs() − commitMarginMs` (margin 10 s), so a stall on the final attempt still leaves
  time to interrupt ComfyUI and commit.
- **On budget exhaustion mid-attempt**: interrupt the job, drop that attempt, and **commit the
  best scored candidate so far** if one exists — a scored winner is never discarded because time
  ran out. Only when `scored` is empty does the run fail.
- **User cancel / work close** (`ctx.signal`) keeps discard semantics: interrupt ComfyUI, drop
  all candidates, run ends `cancelled`, the previously committed image untouched.

### 4.5 Final selection: best-of, with early accept

**Keep every attempt's score and commit the highest-scoring image; stop early when an attempt
clears the accept rule (§4.3).** Prompt revision is noisy — attempt 3 can regress below attempt
1, and since every attempt is already scored, best-of costs zero extra model calls; last-is-best
throws information away for nothing. Ties break toward the latest attempt (it embodies the most
revision guidance). *Rejected:* a final side-by-side pick where the VLM sees all candidates in
one message (multi-image messages are the least portable corner of OpenAI-compatible VLM
endpoints, and per-attempt scores already answer the question); last-is-best (regression-blind).

Candidate images are held **in memory only** (≤ 6 attempts × a few MB) for the duration of the
run; the winner is committed, the rest are dropped (§6).

### 4.6 Latency & cost budget

Under the stated assumption (10–90 s per image; VLM critique on a downscaled image 2–5 s):

| Step | Calls | Fast box (~15 s/image) | Slow box (~90 s/image, 3 attempts) |
|---|---|---|---|
| Intent brief assembly | 0 (storage reads) | <0.1 s | <0.1 s |
| Compose | 1 low text | 1–2 s | 2 s |
| Generate | 1–3 ComfyUI | 15 s each | 270 s |
| Critique | 1–3 low VLM (+image) | 2–5 s each | 15 s |
| Revise | 0–2 low text | 1–2 s each | 4 s |
| Commit | 0 | <0.1 s | <0.1 s |
| **Total** | | **~20–60 s** | **~5 min** (budget gate may trim to 2 attempts) |

Token spend per section: roughly 3–5 low-model calls × 2–4 k prompt tokens ≈ 10–20 k low-lane
tokens — cents at typical small-VLM pricing, and pure background. Every call's usage is recorded
as `usage` run events with `call: "pipeline"` (05 §run record), so cost rollups include
illustration spend without special-casing.

---

## 5. Where illustration tasks come from, and the user's override paths

| Trigger | Mechanism | Priority |
|---|---|---|
| **Consolidation/enrichment** (the default flow) | Harness scheduler: section freezes → `enrich-section` → on success, `illustrate-section` (05 §scheduler). One illustration per section, automatically. | scheduler-initiated (tail of the illustration lane) |
| **Staleness sweep** | A section whose illustration is stale — word count moved > `illustrationStaleWordDeltaPct` (default 15 %) from `meta.sourceWordCount`, **or** missing on a frozen leaf section (02 §staleness) — is re-illustrated by the idle sweep (interactive lane empty 60 s + ≥ 1 SSE subscriber, 05). User uploads and tombstones are never swept (§6). | scheduler-initiated |
| **User: illustrate/regenerate a section** | Section header menu → "Illustrate" / "Regenerate…" with an optional one-line guidance box ("show the storm from the cliff, dusk light"). `POST /tasks {kind: "illustrate-section", sectionId, guidance?}`. | user-initiated (jumps ahead of scheduler jobs in the lane) |
| **User: world-entry image** | World editor → "Generate image" (+ optional guidance). `POST /tasks {kind: "world-image", entryId, guidance?}`. | user-initiated |

Consolidation **undo** cancels queued/running illustrate tasks targeting the un-frozen sections
before their directories are removed (02 §undo, via the harness's cancel-by-target).

**Override paths** (all three ship in M1 — they are the safety valve that lets the automatic
loop stay simple):

1. **Regenerate with guidance** — same task kind, `guidance: string(≤500)` on the `TaskSpec`
   (05 §task kinds) threaded into the composer (rule 6, §4.2). The old image stays in place until
   the new winner commits (atomic overwrite), so a failed regeneration never leaves a hole.
2. **Upload own image** — `POST …/illustration` with a raw `image/png` body (≤ 10 MB, matching
   the API layer's body parser and the PNG-on-disk rule; convert other formats externally).
   Recorded with `source: "user"`, `runId: null`. Pinned: excluded from staleness sweeps until
   the user deletes or regenerates.
3. **Delete** — removes the PNG and writes the **tombstone** variant of the illustration slot
   (§6). The section then simply has no illustration, and the sweep does **not** resurrect it —
   deleting an image the app keeps regenerating would be maddening.

Slot transitions (all through `StorageService`, §6):

| Action | Slot written |
|---|---|
| Loop commit / user upload | `IllustrationMeta` (replaces whatever was there, including a tombstone) |
| Delete | `{ suppressed: true, deletedAt }` |
| **User** "Illustrate" on a suppressed section | `clearSuppression(id)` (slot → `null`), then the task is enqueued — **only a user-initiated illustrate clears a tombstone**; the scheduler sweep never does (it skips tombstones entirely, §10), so the harness calls `clearSuppression` only when the task's initiator is the user (`harness/service.ts`) |
| World-image delete | slot/sidecar removed outright — world images are only ever generated on explicit request, so no tombstone is needed |

---

## 6. Storage: files, metadata, candidates

Everything user-visible follows the data-model layout (02 §layout); the pipeline writes only
through `StorageService`.

```
works/<slug>/
  sections/<NNN>-<slug>.<shortid>/
    illustration.png                 # the one committed image (atomic overwrite)
    section.json                     # enrichments.illustration = IllustrationSlot (02 owns the union)
  world/
    images/<entryId>.png             # committed world-entry image
    images/<entryId>.json            # IllustrationMeta sidecar (world entries have no section.json)
  runs/<YYYY-MM>/<runId>.jsonl       # the FULL loop transcript: brief, composed prompts,
                                     #   per-attempt seed/score/critique JSON, timings, usage
```

The section's illustration slot is the three-state union owned by 02
(`packages/shared/src/enrichment.ts`):

```ts
export const IllustrationSlot = z.union([
  z.null(),                                                      // absent
  IllustrationMeta,                                              // present
  z.object({ suppressed: z.literal(true), deletedAt: IsoTime }), // tombstone: user deleted; never regenerate
]);
```

`IllustrationMeta` itself is owned here:

```ts
// packages/shared/src/illustration.ts
export const IllustrationMeta = z.object({
  source: z.enum(["agent", "user"]),
  runId: Ulid.nullable(),              // null iff source === "user" (uploads have no run)
  generatedAt: IsoTime,
  sourceHash: Hash.nullable(),         // content.md hash at generation; null for world images & uploads
  sourceWordCount: z.number().int().nonnegative().nullable(),
                                       // word count at generation — makes the >15 % staleness rule
                                       //   recomputable from files alone; null for world images & uploads
  entities: z.array(Ulid).default([]), // matched world-entry ids, recorded at compose time (§4.2);
                                       //   the established-imagery lookup key (§7)
  prompt: z.string().nullable(),       // the winning composed prompt; null for uploads
  workflow: z.string().nullable(),     // registry name, e.g. "default"
  workflowHash: Hash.nullable(),       // ResolvedWorkflow.contentHash at generation time
  seed: z.number().int().nullable(),
  attempts: z.number().int().min(1).nullable(),   // rounds actually run
  score: z.number().min(0).max(10).nullable(),    // winner's critique score
  guidance: z.string().nullable(),
});
```

Commits go through `putIllustration(sectionId, png, meta)` /
`putWorldImage(entryId, png, meta)` (atomic overwrite, 02 §StorageService); deletion through
`suppressIllustration(sectionId)` / `clearSuppression(sectionId)`. The storage change hook emits
`enrichment.updated {kind: "illustration", section}` on the work's SSE stream, carrying the
fresh `SectionRow` — including `illustrationVersion`, the **PNG's content hash** (bumps on both
"new content" and "same content, regenerated"; 03 §images uses it for immutable caching).

This satisfies files-as-truth: a human reading `section.json` sees *what prompt, which workflow,
which seed, how many rounds, what score, which entities*; a human wanting the full story opens
the run JSONL named by `runId`. The `run_artifacts` index row (`kind: "illustration"`, 02 §index)
links image → run for the provenance UI with no new machinery. And every staleness input
(`sourceHash`, `sourceWordCount`) lives in the meta, so a rebuilt index recomputes
`illustration_stale` exactly (02 §staleness).

**Candidates: discarded in M1.** Only the winner is written; losing attempts survive as text
(their prompts, seeds, and critiques in the run file) but not as pixels. Rationale: images are
the one bulky artifact in the system, any attempt is reproducible from the recorded
prompt + seed + workflow hash (byte-identical on the same ComfyUI install), and "exactly one
illustration per section" is a data-model invariant. The candidate picker ("choose from 3") is
**M2**: the loop already produces scored candidates in memory; M2 persists them to
`.cowrite/illustration-candidates/` (app-private, 02 §layout) and adds the picker UI.
*Rejected:* keeping all candidates in user-visible space (violates the one-image invariant,
grows the work directory with rejected art nobody chose).

---

## 7. Visual consistency without character-reference features

MVP has no IPAdapter/reference-image/img2img plumbing — consistency is **nudged textually**,
three ways, all already present in §4.2:

1. **Stable descriptions at the source.** World entries are the canonical place for appearance
   ("Appearance:" lines in the entry body are the documented convention); the composer receives
   matched entries' bodies and must render characters from them.
2. **Established-imagery reuse, keyed by entity id.** The composer is given the last winning
   prompts whose recorded `entities` overlap the current matched entries, and instructed to copy
   physical descriptions *verbatim* (§4.2 rule 4). Because winning prompts are durably stored in
   `IllustrationMeta.prompt` and the entity ids alongside them, the vocabulary converges over
   time ("cropped grey hair, storm-lantern in hand" recurs) instead of drifting — and the lookup
   survives the no-names rule, since it never text-matches prompt strings.
3. **One workflow, one style.** Routing every section through the same registered workflow keeps
   checkpoint/LoRA/style constant, which is most of what readers perceive as consistency; the
   critic's `consistency` axis (§4.3) catches the remainder against the brief's descriptions.

*Structured-for, deferred:* passing the world entry's existing image to the critic as a second
`image_url` for a true visual comparison, and reference-conditioning workflows (a registry entry
whose graph takes an image input) — the registry schema and marker convention leave room
(`%refimage%` is the obvious future marker), but multi-image VLM support and per-install ComfyUI
node availability are too uneven to bet the MVP on.

---

## 8. API surface and SSE progress

Task submission, cancellation, and run retrieval are the generic task/run endpoints (03 §tasks,
§runs) — illustration adds no parallel task API. Image bytes are served by the API layer's
image routes with immutable caching keyed on the PNG content hash (03 §images). This subsystem
contributes:

| Method & path | Purpose | Notes |
|---|---|---|
| `GET /api/illustration/health` | ComfyUI reachability + registry validation report | `{ ok, comfy: {ok, detail?}, workflows: [{name, label, ok, error?}], route: {section: {name, ok}, world: {name, ok}} }`; powers the settings-page status row |
| `POST /api/works/:w/sections/:s/illustration` | user upload, raw `image/png` (≤ 10 MB) → `{illustrationVersion}` | writes `source: "user"` meta (`runId: null`); replaces any tombstone; emits `enrichment.updated` |
| `DELETE /api/works/:w/sections/:s/illustration` | delete + tombstone (§5) | idempotent; emits `enrichment.updated` |

World-entry image upload/delete are 03 §world routes (`POST/DELETE /works/:w/world/:e/image`);
their write semantics — sidecar `IllustrationMeta`, no tombstone — are defined in §5/§6 and
implemented by this subsystem's storage calls. *Cut:* a separate `GET /api/illustration/workflows`
— its data is a subset of the health report and its only consumer (a per-task workflow picker) is
deferred; it returns with the picker.

**What the UI sees during a run.** The pipeline reports progress through
`RunContext.progress()`; the harness forwards it as the canonical `task.progress` `WorkEvent`
(03 §SSE):

```ts
// packages/shared/src/illustration.ts — the phase enum (08 owns; events.ts embeds it)
export const PipelinePhase = z.enum(["composing", "submitting", "queued", "generating",
                                     "critiquing", "revising", "committing"]);

// packages/shared/src/events.ts (owned by 03; shape recapped)
z.object({ type: z.literal("task.progress"), taskId: Ulid,
           phase: PipelinePhase,
           attempt: z.number().int().min(1), maxAttempts: z.number().int().min(1),
           pct: z.number().min(0).max(100).nullable() })   // ComfyUI progress; null outside "generating"
```

The section's image slot renders a shimmer with a caption cycling
`Composing prompt → Generating (attempt 2/3, 64 %) → Critiquing…`, then swaps in the committed
PNG on `task.artifact` + `enrichment.updated` (04 §image slot). On SSE reconnect the event bus
replays the latest `task.progress` alongside the synthetic snapshot sequence (03 §resume), so a
refreshed tab resumes the caption mid-run. Intermediate candidate images are **not** streamed
(no temp-image endpoint in MVP; the phases keep the run legible without pixels — M2's picker
adds candidate access). Failures surface as `task.failed` with code `pipeline` and a `detail`
string (`comfy_unreachable`, `workflow_invalid`, `comfy_exec_error`, `comfy_timeout`,
`commit_target_missing`) the image slot renders as a badge; unconfigured/broken-workflow
submissions never start at all (`409 config_missing`, §3).

---

## 9. Module layout

```
apps/server/src/illustration/
  index.ts               # IllustrationPipeline: runSectionIllustration(sectionId, guidance, ctx)
                         #   / runWorldImage(entryId, guidance, ctx) → RunArtifact[] (05 §handoff)
  loop.ts                # §4.1 round loop, budget gate, best-of selection, accept rule
  composer.ts            # intent-brief assembly + compose/revise low-model calls (§4.2)
  critic.ts              # VLM critique call, downscale, CritiqueResult parsing + repair (§4.3)
  comfy/
    client.ts            # ComfyClient: submit / ws-track / history-poll / view / interrupt (§2.3)
    inject.ts            # marker scan + pure inject() (§2.2)
    registry.ts          # config load, per-workflow validation records, ResolvedWorkflow cache (§3)
  routes.ts              # Fastify plugin: §8 routes (health, section upload/delete)
  __tests__/
prompts/
  illustrate-compose.md  illustrate-revise.md  illustrate-critique.md   # wording owned by 07
packages/shared/src/
  illustration.ts        # ComfyConfig, WorkflowEntryConfig, IllustrationTimeouts,
                         #   IllustrationMeta, CritiqueResult, PipelinePhase
packages/mock-llm/src/
  comfy.ts               # mock ComfyUI server (§11)
  scenarios/comfy-*.json
```

The pipeline entry points match the harness contract exactly (`RunContext` — 05 §illustration
handoff); `loop.ts`, `inject.ts`, `composer.ts` brief-building, and `critic.ts` parsing are pure
or dependency-injected and unit-testable without HTTP.

---

## 10. Failure modes

| Failure | Behavior |
|---|---|
| ComfyUI unreachable | Health gate (§2.4): scheduler tasks fail quietly (run recorded; staleness badge stays); user tasks get `pipeline`/`comfy_unreachable` toast + retry. No retries against a dead box beyond the submit retry pair. |
| `POST /prompt` → 400 node errors | `pipeline`/`workflow_invalid`, non-retryable; error detail names the failing node. Usually caught earlier by registry validation (§3), which would have blocked the task with `config_missing`. |
| `execution_error` mid-job | Retried **once** with the same prompt + fresh seed (transient VRAM OOM is common); second failure fails the *attempt* (slot consumed, prompt carries over, no revise — §4.1). A systematic error fails the remaining attempts fast and the run ends `pipeline` with the ComfyUI exception message. |
| WS drops / silent | Transparent fallback to `/history` polling every 2 s (§2.3); progress degrades to phase-only (`pct: null`). Never fails a job by itself. |
| Queue/exec timeout | Interrupt/dequeue our job, fail the attempt → same policy as `execution_error`. |
| Run budget exhausted | Budget gate skips further attempts; mid-attempt exhaustion interrupts ComfyUI and **commits the best scored candidate so far** (§4.4). Fails only when no attempt ever scored. |
| VLM critique unparseable | One repair retry; then neutral `{verdict: "revise", overall: 5}` — the loop proceeds; never wedges. |
| Composer emits tag-less/overlong output | The pipeline is a harness guest with its OWN loop, so it runs its own single repair turn on a missing `<image-prompt>` block (composer.ts, not the harness runner) — and if that still misses, uses the whole trimmed response (never wedges on a tag miss); >150-word prompts pass through with a logged warning (diffusion text encoders truncate gracefully). |
| Task aborted (user cancel / work close) | `ctx.signal` propagates: interrupt ComfyUI, drop in-memory candidates, run ends `cancelled`; the previously committed image is untouched (commit is the only write). |
| Commit target gone (section merged/split/deleted or work restructured during the ~30–300 s run) | `putIllustration` fails; the run fails quietly with detail `commit_target_missing`, no retry — the staleness sweep re-enqueues for whichever section now owns that text (missing illustration on a frozen leaf counts as stale, 02 §staleness). |
| Image bytes huge / not PNG | 32 MB cap on `/view` reads; non-PNG output from exotic save nodes is transcoded via `sharp`, failure ⇒ attempt fails. |
| Server crash mid-run | Harness startup finalizer marks the run `crash`; no partial files exist (memory-only candidates, atomic commit). Section keeps its old image (or none — in which case missing-counts-as-stale re-queues it). |
| Same section re-illustrated while a sweep job is queued | Harness lane dedupe by `(kind, targetId)` (05 §scheduler) — no duplicate jobs. |
| Suppressed / user-pinned image hit by the sweep | Never enqueued: the sweep skips tombstones and `source: "user"` metas (02 §staleness). |
| Scheduler-initiated illustrate keeps failing on one section | Each failed (non-deduped) scheduler illustrate feeds a **per-section illustrate failure cooldown** (`harness/scheduler.ts`) — the same exponential backoff as the enrichment cooldown (base = one sweep window, capped ~1 h), so a section that fails every attempt isn't retried on every sweep. A content edit to that section resets the cooldown (it was about the old prose); a user-initiated illustrate ignores it. |

---

## 11. Mock ComfyUI server and test plan

`packages/mock-llm/src/comfy.ts` — a `node:http` + `ws` server implementing the §2.1 surface, driven
by the same ordered-scenario mechanism as the mock LLM (unmatched request ⇒ loud test failure;
09-testing.md owns the shared fixture story):

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
    z.object({ type: z.literal("hang"), ms: z.number().optional() }), // delay execution_start by
                                                              // `ms` (default 0), then hang
                                                              // INDEFINITELY (readyAt = Infinity):
                                                              // only /interrupt or /queue {delete}
                                                              // ends it — timeouts + budget gate
  ]),
});
```

It honors `POST /interrupt` and `POST /queue {delete}` (emitting `execution_interrupted`), serves
`/system_stats`, `/history/:id`, `/view`, and streams the standard message sequence over `/ws`.
`pnpm mock:comfy` runs it standalone on `:8188` with an always-succeed scenario, and
`COWRITE_MOCK_LLM=1` / `--mock` boots it in-process alongside the mock LLM so the whole app demos
offline (03 §env, 09-testing.md).

**Test tiers:**

1. **Unit:** `inject.ts` marker scan + injection (property: output graph differs from template
   only at mapped fields; template never mutated); registry validation matrix (missing
   `%prompt%`, duplicate `%prompt%`, missing `%seed%`, zero/multiple whitelist output nodes
   without `%output%`, dangling `route` name — each yields the right per-workflow error record);
   `CritiqueResult` parse/repair + the accept rule and `asRevise` coercion (§4.3);
   best-of selection math (regression case: scores `[6, 8, 4]` picks attempt 2; early accept
   stops the loop); budget-gate arithmetic (`attemptEstimateMs` from observed durations).
2. **Integration (Vitest, real Fastify + mock-comfy + mock low lane):** golden scenarios —
   `illustrate-accept-first` (1 attempt, early accept), `illustrate-revise-then-accept`,
   `illustrate-best-of-three` (no accept; asserts the committed PNG is the top-scored fixture via
   the tEXt-embedded prompt), `budget-exhausted-commits-best` (hang on attempt 2; asserts
   attempt 1's image commits and `/interrupt` was called), `comfy-400-invalid`,
   `exec-error-then-ok` (retry-once path), `exec-error-consumes-slot` (twice-failed attempt →
   prompt unchanged on the next), `ws-drop-poll-fallback`, `hang-exec-timeout`,
   `cancel-mid-generate` (asserts `/interrupt` received + no file written), `world-image-happy`,
   `upload-then-sweep-skips` (user image never auto-replaced), `delete-writes-tombstone` +
   `illustrate-clears-tombstone`, `entities-drive-established-imagery` (second section's brief
   contains the first winner's prompt via shared entity id). Each asserts: the `task.progress`
   event sequence on the work stream, run-file `RunEvent`s (Zod-parsed), the `IllustrationSlot`
   on disk, and the `run_artifacts` index row.
3. **E2E (Playwright):** press "Illustrate" on a chapter → shimmer with phase captions → image
   appears; "Regenerate…" with guidance → new image + provenance view shows the guidance and
   critique transcript.

---

## 12. MVP cut

**M1** — the illustration basic loop, end to end:

- `ComfyClient` (submit / WS progress / history / view / interrupt), polling fallback, timeout
  ladder, health check, per-workflow registry validation (task-time `config_missing`, never
  startup-fatal)
- `%marker%` node-title convention with `%prompt%` + `%seed%` required, `%output%` +
  whitelist-fallback output rule; single `default` workflow; registry structure supporting many
- Full agentic loop: composer (natural-language, no-tags rules, entity recording), bounded
  critique/revise, budget-aware attempts, best-of selection with early accept; text-only
  consistency nudges (§7)
- `illustrate-section` + `world-image` with scheduler triggers, guidance on regenerate, user
  upload, delete-with-tombstone
- `IllustrationMeta` (+ slot union writes) on disk, full transcript in run files; candidates
  discarded
- `task.progress` on the per-work SSE stream; health + upload/delete routes; mock ComfyUI +
  golden scenarios

**M2:**

- Candidate picker: persist scored attempts to `.cowrite/illustration-candidates/`, "pick from
  N" UI, interim candidate access

**Structured-for, deferred beyond M2:**

- Multiple workflows routed per kind / per-task workflow picker UI (+ the `workflows` listing
  endpoint) — registry + `route` config already support it
- `%width%`/`%height%` actually varied (markers mapped now; e.g. portrait aspect for world
  entries later)
- Reference-image consistency (`%refimage%` marker, world image passed to the critic)
- Batch back-illustration ("illustrate all un-illustrated chapters") — trivially a loop over the
  existing task, but it's surprise GPU-hours; wants a confirm UI
- ComfyUI queue-position display from `status` messages (nice, not needed)

---

## 13. Contracts

Shared schemas this subsystem **owns** (`packages/shared/src/illustration.ts`):

| Schema | Consumers |
|---|---|
| `ComfyConfig`, `WorkflowEntryConfig`, `IllustrationTimeouts` | 03 §config (`AppConfig.comfyui` embeds it; hot-reload triggers registry reload) |
| `IllustrationMeta` | 02 §enrichment (the present-state of `IllustrationSlot`; world-image sidecars), 03 §sections (`SectionRow` staleness inputs), 04 §provenance |
| `CritiqueResult` | run transcripts (05 §run record), 04 §provenance view |
| `PipelinePhase` | 03 §SSE (`task.progress`), 04 §image slot captions |

Server-side interfaces owned here (`apps/server/src/illustration/`): `IllustrationPipeline`
(`runSectionIllustration` / `runWorldImage` → `RunArtifact[]`), `ComfyClient`,
`ResolvedWorkflow`, `inject()`.

Contracts this subsystem **consumes**:

| Contract | Owner | Used for |
|---|---|---|
| `RunContext` (`lowClient`, `emit`, `progress`, `signal`, `remainingMs`), `LlmClient` with `image_url` parts on the low lane, illustration lane (capacity 1 app-wide, user jumps scheduler), `illustrationBudgetMs`, lane dedupe, cancel-by-target | 05 §illustration handoff, §scheduler | the run harness the loop lives in |
| `TaskSpec` variants `illustrate-section` / `world-image` (with `guidance`), `Task`, `RunEvent`, `RunArtifact` | 05 §task kinds, §run record | task submission shape; transcript events |
| `WorkEvent` (`task.progress`, `task.artifact`, `task.failed`, `enrichment.updated`), reconnect snapshot semantics | 03 §SSE | all progress the UI sees |
| `ErrorCode` (`pipeline`, `config_missing`) | 03 §errors | failure surfacing |
| `StorageService`: `putIllustration`, `putWorldImage`, `suppressIllustration`, `clearSuppression`, `matchWorldEntries`, `listIllustrationMetas` | 02 §StorageService | all reads and commits |
| `IllustrationSlot` union; staleness rules (`sourceWordCount` delta, missing-counts-as-stale, pinned/tombstone skip) | 02 §enrichment, §staleness | delete/upload semantics; sweep behavior |
| Image serving + `illustrationVersion`/`imageVersion` (PNG content hash), raw `image/png` body parser, world image routes | 03 §images, §world | upload/delete routes and cache-busting |
| Prompt markup grammar + `prompts/illustrate-{compose,revise,critique}.md` wording | 07 | brief rendering, `<image-prompt>` output block |
| Mock scenario mechanism + fixture layout | 09 | §11 test tiers |

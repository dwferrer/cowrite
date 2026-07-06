# 06 — Smart Context Management Engine

Scope: the server subsystem that decides *what the model sees* for every interactive agentic
task (`continue`, `instructed-continue`, `quick-edit`, `edit-task`): assembling a prompt that
covers the whole work through hierarchical summaries with real prose at the frontier, serving
the planning-stage tools that let the model expand exactly the pieces it needs, tracking what
was used, decaying expanded items back to summaries under a soft token budget, and keeping the
whole thing cache-friendly and cheap. This doc owns the fidelity model, the persistent context
ledger, the default context map, voice anchors, prompt-region assembly and ordering, the tool
interface and planning caps, the citation/decay/eviction algorithms, token estimation, the
`/context/*` REST routes, and the session API the agent harness drives (05 §runner). Region
*tag grammar* and template wording belong to 07-prompting.md; background tasks
(`enrich-section`, `propose-boundaries`, illustration) never touch this subsystem.

## Key decisions

- **Total coverage invariant** — the default context map represents the entire work: every
  section at ≥ `name` fidelity (short summary when available), every un-consolidated snippet at
  full text; the model can never contradict text that was silently absent.
- **Local context = the un-consolidated snippet region, verbatim** — no separate "tail tokens"
  knob; the consolidation thresholds (02 §consolidation) are the single bound on this region's
  size (~9,000 words worst case), so prompt cost and consolidation policy are one dial.
- **Stability-ordered regions with an append-only `<expanded-context>`** — elevated content
  lives in its own region rather than folding into the skeleton, so elevations are pure appends
  and the cached prefix survives.
- **The skeleton is byte-stable between consolidation/enrichment events** — and those events
  are debounced and chapter-scale by design, not per-task.
- **Pinned voice anchors by pure positional stratification** — excerpts from across the work
  keep the voice dynamic (per the brief) with zero scoring machinery and zero per-task churn.
- **TTL-in-actions ledger** — opened items survive 3 completed tasks by default; exceeding the
  soft budget accelerates decay; the hard cap evicts by a legible keep-score. Ledger state is a
  rebuildable cache in `.cowrite/context/`.
- **One stateful session per task, snapshot-isolated** — the engine snapshots the manuscript at
  `beginTask`; background enrichment landing mid-task is queued and applied at the next task, so
  the prompt prefix never shifts under a running loop.
- **Prose with no tool calls is the composition** — the engine's only composition hand-off is
  an append-only `<local-context-refresh>` turn; nothing is discarded or re-paid.
- **One token estimator, server-side** — `gpt-tokenizer` (cl100k) as a consistent ±10 %
  estimate, hash-cached, computed by the engine alone; the web and `/tasks/estimate` render
  numbers the engine produced.
- **Plain-text search, no vector RAG** — a linear scan over a few MB of Markdown answers the
  "grab precise info" case the brief names; retrieval infrastructure is deferred until it earns
  its place.

---

## 1. Overview

Per interactive task, the engine:

1. **Assembles** a prompt covering the whole work: a summary skeleton of every section, voice
   anchors from across the manuscript, the situation pane, and all un-consolidated snippets as
   full prose at the bottom.
2. **Serves tools** during planning: expand a section or world entry, search the manuscript,
   or simply start writing.
3. **Tracks usage**: items the model opened or cited stay elevated for the next few tasks,
   then decay back to their default fidelity.
4. **Enforces budgets**: a soft budget whose overage accelerates decay (exceeding it is
   allowed), and a hard cap enforced by eviction.
5. **Stays cache-friendly**: append-only within a task's loop; stability-ordered regions
   across tasks; a `cache_break` usage event whenever a region's bytes change, so hit rates are
   measurable.

One mechanism shared by all four interactive task kinds; no per-entry activation rules, no
embeddings; every piece of derived state is regenerable from the work directory.

---

## 2. Core concepts and fidelity model

### 2.1 Context items

Everything that can occupy prompt space is a **context item**, addressed by a bare ULID plus an
explicit `kind` (never an id prefix — 02 §ids):

| Item kind | Fidelity levels | Notes |
|---|---|---|
| `section` | `name` → `short` → `long` → `full` | leaf sections carry prose; interior sections summarize their subtree |
| `world` | `name` → `short` → `full` | `short` is the entry's one summary; `long` is not defined for entries |
| `snippet` | always `full` | un-consolidated frontier prose; never summarized, never elevated |
| situation | always `full` | singleton; included whenever non-empty |
| anchor | always `full` | derived excerpt of a frozen section (§4.3) |

Fidelity is a total order. `context_expand` moves an item up one or more levels; decay moves it
back down to its **default fidelity** (never below — the default map always covers the work).

```ts
// packages/shared/src/context.ts
import { z } from "zod";
import { Ulid, Hash } from "./ids";

export const Fidelity = z.enum(["name", "short", "long", "full"]);
export type Fidelity = z.infer<typeof Fidelity>;
export const FIDELITY_ORDER: Fidelity[] = ["name", "short", "long", "full"];

export const ItemKind = z.enum(["section", "snippet", "world"]);
export const ItemRef = z.object({ kind: ItemKind, id: Ulid });
```

### 2.2 The context state (the "ledger")

The persistent per-work record of which items are elevated above their default fidelity, why,
and for how long. Default-fidelity items are *not* stored — the default map is computed from
the section tree at every task (§4), so the ledger stays tiny and the whole structure is
rebuildable.

```ts
export const ElevationSource = z.enum([
  "tool",     // model opened it via tool call during planning
  "cite",     // model listed it in finish_planning citations
  "user",     // user selected it in the edit-task pane (M2)
  "target",   // it is / contains / neighbours the passage an edit targets
]);

export const ElevatedItem = z.object({
  kind: z.enum(["section", "world"]),   // snippets are always full; never elevated
  id: Ulid,
  fidelity: Fidelity,                   // elevated level (above computed default)
  ttl: z.number().int().min(0),         // remaining "actions" (completed tasks) before decay
  source: ElevationSource,
  elevatedAtTask: z.number().int(),     // IMMUTABLE slot marker (see below)
  lastCitedTask: z.number().int(),      // recency; reset on re-open / re-cite
  tokens: z.number().int(),             // estimated cost at this fidelity (re-checked, §8.3)
  sourceHash: Hash,                     // content hash at last render; staleness check (§10)
});

export const AnchorExcerpt = z.object({
  sectionId: Ulid,
  start: z.number().int(),              // half-open char range into the section's content.md
  end: z.number().int(),
  tokens: z.number().int(),
  contentHash: Hash,                    // hash of the excerpt text; mismatch ⇒ re-derive (§4.3)
});

export const ContextState = z.object({
  version: z.literal(1),
  taskCounter: z.number().int(),        // count of *completed* tasks ("actions")
  elevated: z.array(ElevatedItem),      // append-ordered; see ordering rules below
  anchors: z.object({
    refreshedAtTask: z.number().int(),
    excerpts: z.array(AnchorExcerpt),
  }),
});
export type ContextState = z.infer<typeof ContextState>;
```

Ordering rules for `elevated` (these are what make `<expanded-context>` append-friendly):

- New elevations are **pushed to the end**; decayed/evicted items are removed in place.
- One entry per `(kind, id)`. Re-elevation to a higher fidelity replaces the entry **in its
  existing position**. `elevatedAtTask` is **immutable** — it records the slot's creation and
  is the eviction tie-break; recency lives in `lastCitedTask` only.
- A replace-in-place changes that slot's rendered bytes, which invalidates the cached prefix
  *from that slot onward* (the bytes after it are preserved, the cache prefix before it is
  too). Cheaper than a full-region rewrite, dearer than a pure append; §5.4 accounts for it.

### 2.3 Per-task session state (ephemeral)

During one task's loop the engine tracks, in memory only:

```ts
interface SessionState {
  taskId: Ulid;
  spec: TaskSpec;                          // interactive kinds only (05 §taxonomy)
  snapshot: WorkSnapshot;                  // tree + summaries + anchors, frozen at beginTask (§10)
  openedThisTask: Map<string /* kind:id */, Fidelity>;
  citations: Set<string /* kind:id */>;    // from finish_planning
  toolCallCount: number;
  planningRounds: number;
  assembledTokens: number;                 // running estimate incl. transcript growth
}
```

Nothing here persists if the task aborts — aborted tasks are not "actions": no elevation, no
decay, no `taskCounter` bump.

---

## 3. On-disk layout and persistence

Engine state persists per work as human-readable JSON under the app-private `.cowrite/`
directory (02 §layout). It is a **derived cache**: missing, corrupt, or schema-mismatched files
cause regeneration with a logged warning — never a fatal error.

```
works/<slug>/.cowrite/context/
  state.json        # ContextState (ledger + anchors) — atomic tmp+rename writes
  usage.jsonl       # append-only usage/profiling events (§8.4)
```

`state.json` is rewritten once per **completed** task, inside `finalize` (§7.2), via
write-to-temp + rename. One engine instance per open work (the work lock in 02 §locking already
guarantees one process; the composition root constructs one engine per `WorkHandle`).

`usage.jsonl` is append-only and never read by the engine itself; it exists because budget and
decay defaults are expected to be re-tuned from real profiles (roadmap M1.5).

Code layout:

```
packages/shared/src/context.ts      # Fidelity, ItemRef, ContextState, BudgetKnobs,
                                    #   candidate/preview DTOs, UsageEvent
apps/server/src/context/
  engine.ts        # ContextEngine: load / beginTask / candidates / preview / reset
  session.ts       # TaskContextSession implementation (§9)
  defaults.ts      # default context map computation (§4)
  anchors.ts       # voice-anchor selection + refresh (§4.3)
  assemble.ts      # region rendering, stability ordering (§5); emits ContextSnapshot
  tools.ts         # tool definitions + handlers (§6)
  search.ts        # literal manuscript/world search
  decay.ts         # finalize-time decay + hard-cap eviction (§7, §8.2)
  estimate.ts      # THE token estimator: gpt-tokenizer + content-hash cache (§8.3)
  snapshot.ts      # WorkSnapshot capture; queued-event application (§10)
  routes.ts        # Fastify plugin for §11 (mounted by 03)
  __tests__/ …
```

---

## 4. The default context map: covering the whole work

At every `beginTask` the engine computes a **default fidelity map** over the snapshot's section
tree and world list, then overlays the ledger's elevations. The map obeys one invariant:

> **Every byte of the work is represented.** Every section appears at ≥ `name` fidelity (its
> short summary when one exists), and every un-consolidated snippet appears at full text.

(The UI's scroll-back fold ladder is a separate, purely presentational mechanism owned by 04;
the two are not coupled. What the model actually saw is shown by the provenance viewer's
`ContextSnapshot` region view, not by the fold state.)

### 4.1 Rules (walking the tree, frontier-relative)

1. **Local context**: *all* un-consolidated snippets, full text, in order, with snippet
   boundaries lightly marked (tags per 07). Never demoted, never evicted. Its size is bounded
   by the consolidation thresholds, not by an engine knob: consolidation triggers at
   `maxFrontierWords = 9,000` (≈ 12–13k tokens worst case) and normally holds the region well
   below that (02 §consolidation documents the same coupling from its side). Raising those
   thresholds directly raises every prompt's cost.
2. **Un-enriched frozen leaf sections** — frozen but with no short summary yet (enrichment
   lags consolidation by design; a crash can widen the gap until the staleness sweep repairs
   it, 02 §staleness) — are included at `full` in the skeleton. The substitutability rule run
   in reverse: where no summary can stand in for the text, the text stands in for the summary.
   These full-text inclusions are exempt from skeleton demotion (coverage beats budget; the
   soft budget may be exceeded, §8). When the summary lands, `full` drops to the normal rules
   below — a skeleton change, but one tied to the same batched enrichment event cadence as
   consolidation itself. A brand-new work with no sections at all is the degenerate case: the
   map is 100 % local context, and that is correct.
3. **Adjacent context**: the 2 chapter-level sections immediately before the frontier get
   `long`.
4. **Same parent**: remaining earlier chapter-level siblings of the current part/arc get
   `short`.
5. **Everything else**: top-level sections get `short`; their chapter-level children get
   `name`; deeper descendants get `name`. Nothing is omitted — a `name` line costs ~10 tokens
   and keeps every id expandable.
6. **World-info**: every entry at `short` (name + its one summary; entries are never key-gated
   — 02 §world). If the region exceeds `worldInfoSummaryBudget` (3,000 tokens), demote entries
   to `name` **largest-first by token count** (tie-break: newest first) until it fits. The
   demotion set is a pure function of entry contents, so it changes only when world-info is
   edited — at which point the region's bytes change anyway. Recency-aware demotion was
   rejected: recently-used entries are already elevated in `<expanded-context>` via the ledger,
   so demoting their skeleton `short` loses nothing, and a recency-keyed set would churn this
   near-top region every few tasks.
7. **Situation**: always included, full, when non-empty (read via the injected situation
   reader; storage in 02 §situation).

"Chapter-level" means the deepest level in the work's `levelScheme` for which enriched sections
exist along the frontier path; with the default flat `["chapter"]` scheme it is simply
"chapter". If no section is enriched anywhere, rules 3–5 have no members and rule 2 carries the
map (bounded, again, by consolidation keeping frozen-but-unenriched sections few).

**Skeleton demotion.** If rules 3–5 exceed `skeletonSummaryBudget` (6,000 tokens) — very long
works — demote uniformly and deterministically: rule-4 `short` → `name` first (document-order
earliest first), then rule-3 `long` → `short`. Never below `name` (the coverage invariant).

Because the local-context boundary *is* the consolidation boundary, sections are always wholly
in or wholly out of the skeleton, and the skeleton's membership changes only when consolidation
or enrichment commits — both debounced, chapter-scale, batched events (02 §trigger). That is
the honest form of the stability claim: **`<global-context>` is byte-identical across tasks
between consolidation/enrichment events and summary/title edits.**

### 4.2 Fidelity rendering

- `name`: one line — the section's path-qualified title (or "untitled `<kind>`") and its id.
- `short` / `long`: the enrichment summary files (02 §enrichments); a *stale* summary is still
  used (best available; the background sweep refreshes it — the engine never blocks on
  enrichment).
- `full`: `content.md` verbatim for leaf sections. For interior sections, `full` is not a
  rendering — see the child-index rule in §6.

### 4.3 Voice anchors

The brief's voice-preservation rule wants roughly 10k tokens of real prose that is *not* just
the latest writing. The local-context region supplies the latest writing (typically 4–12k
tokens); **voice anchors** supply the range: 3–5 pinned excerpts (≈ `anchorTokensTotal / K`
tokens each, 4,000 total) sampled from across the finished manuscript.

Selection — pure positional stratification, deterministic given inputs:

```
selectAnchors(snapshot, budget = 4000):
  candidates = frozen leaf sections with content, excluding the newest one
               (its mood already adjoins the frontier)
  if candidates is empty: return []          # young work; local context is all we have

  K = min(4, len(candidates))
  divide the manuscript by cumulative token position into K equal spans
  for each span: pick the candidate with the largest content token count
                 (tie-break: document order); skip already-picked sections
  from each winner, take a contiguous excerpt from the section START
  (scene openings establish voice fastest), sized budget/K,
  cut at the last paragraph boundary within size
```

Each excerpt stores its char range, token count, and a `contentHash` of the excerpt text.

**Refresh policy** (cache-critical — anchors are *pinned*):

- Recomputed from scratch when a chapter-level section finishes enrichment — the engine
  subscribes to storage's in-process `enrichment.completed` channel (03 §in-process channels);
  like all external changes, the refresh is queued and applied at the next `beginTask` (§10).
- `POST /context/reset` recomputes everything.
- Per-excerpt staleness: at `beginTask`, each excerpt's `contentHash` is checked against the
  snapshot. On mismatch (the user edited that section), **only that excerpt is re-derived** —
  re-run the selection for its span against the edited section — and it keeps its position in
  `<voice-anchors>`, so only that region invalidates, from that excerpt onward.

Between refreshes the anchor bytes are identical, so `<voice-anchors>` never breaks the cache
on ordinary tasks.

*Rejected:* random sampling per task (destroys prompt caching, non-reproducible); letting the
high model pick anchors during planning (expensive tokens for a job heuristics do fine);
embedding-based diversity (no vector infrastructure in this phase); mood/dialogue-ratio scoring
(deferred — stratification alone satisfies "a range of pieces from different moods throughout
the work", and the extra machinery imposed cross-subsystem obligations for marginal gain).

---

## 5. Prompt assembly and ordering (cache-friendliness)

### 5.1 Region order — by decreasing stability

The single most important rule: **more stable content earlier**, so prefix caching survives the
churn concentrated at the bottom. Canonical order (tag grammar and exact markup owned by
07-prompting.md; this doc owns the ordering and each region's contents):

| # | Region | Contents | Changes when |
|---|---|---|---|
| 1 | `<instructions>` | static per task kind (07 templates) | app upgrade |
| 2 | `<world-info>` | all entries at map fidelity, **entry-creation order** | user edits world-info |
| 3 | `<global-context>` | section skeleton, document order, default fidelities only | consolidation / enrichment events, summary or title edits |
| 4 | `<voice-anchors>` | pinned excerpts (§4.3) | ~once per chapter |
| 5 | `<expanded-context>` | ledger elevations, append-ordered (§2.2) | elevation (append) / decay & re-elevation (slot) |
| 6 | `<situation>` | the situation pane, full, when non-empty | user edits it |
| 7 | `<task>` | this task's instruction (instructed-continue text, edit instruction + selection excerpt, or the standing continue directive) | every task |
| 8 | `<local-context>` | all un-consolidated snippets, full prose, boundaries marked; the edit target marked in place for snippet targets | every task (frontier grows) |
| 9 | `<target>` (M2, frozen-section targets only) | the target span + `targetWindowTokens` of surrounding prose each side | per edit task |

A compressed illustration (real tags per 07):

```not-xml
<instructions>…</instructions>
<world-info>
  <entry id="01J2N8…" name="Mara Voss" fidelity="short">…</entry>
</world-info>
<global-context>
  <section id="01HZQA…" name="The Lighthouse Keeper" fidelity="short">…</section>
  …
</global-context>
<voice-anchors>
  <excerpt from="The Lighthouse Keeper" tokens="1010">…prose…</excerpt>
</voice-anchors>
<expanded-context>
  <section id="01J2KF…" name="The Storm Glass" fidelity="full">…</section>
</expanded-context>
<situation>Mara confronts the harbormaster; storm building.</situation>
<task>Continue the story.</task>
<local-context>…all live snippets, newest last…</local-context>
```

Key decision: **elevated content lives in a separate `<expanded-context>` region, not folded
into `<global-context>` at document position.** The skeleton therefore stays byte-identical
between consolidation/enrichment events, and new elevations are pure appends. Each expanded
block carries its full section path so the model can situate it. The duplication (a `short`
summary in the skeleton *plus* `full` text in expanded-context) costs a few hundred tokens —
cheap next to invalidating a 20k+ token prefix mid-prompt on every elevation.

*Rejected alternative:* folding expansions into the skeleton in document order — reads more
naturally, but every elevation and decay would break the cache from the middle of the prompt.

### 5.2 Within one task's loop — pure appends

The assembled prompt is the first user message. Each planning round appends
assistant-tool-call + tool-result messages; nothing earlier is ever rewritten, and the `tools`
array is identical on every request (05 §loop), so each round and the composition call reuse
the full cached prefix.

### 5.3 The composition hand-off

The brief requires the frontier prose to sit as near the bottom as possible *during
composition*; after planning rounds, tool chatter sits below `<local-context>`. When planning
ends — the model called `finish_planning`, or the engine's caps forced it — the engine produces
one final **append-only** user turn:

```not-xml
<local-context-refresh>
  # the last `refreshTailTokens` (1,000) tokens of <local-context>, verbatim
</local-context-refresh>
Begin writing now. Continue directly from the prose above. No tool calls.
```

This is cache-perfect (a pure append), costs ≤1k duplicated tokens, and puts real prose
immediately above the generation point — the mitigation the brief prescribes for
reasoning-model voice collapse. `compositionRefreshTurn()` returns `null` when the model made
zero tool calls — the common case for plain `continue` — because `<local-context>` is then
already at the bottom and **the prose the model just streamed is the composition** (never
discarded or regenerated; 05 §loop owns that rule and the `tool_choice: "none"` mechanics).

*Rejected:* rebuilding a fresh prompt for composition with expansions folded in — cleaner
transcript, but discards the entire cached planning prefix.

### 5.4 What changes bytes, and when (accepted cache breaks)

| Event | Invalidates from | Frequency |
|---|---|---|
| Frontier grows / task changes | `<task>` + `<local-context>` tail | every task — by design, the cheapest position |
| New elevation | nothing (pure append inside `<expanded-context>`) | per opened item |
| Decay / eviction / re-elevation | that item's slot in `<expanded-context>` | batched at task finalize; only under TTL expiry or budget pressure |
| Consolidation applies (snippets → section) | `<global-context>` + `<local-context>` | ~once per chapter, debounced (02 §trigger) |
| Enrichment lands (summary added; rule-2 `full` → `short`) | `<global-context>` | batched behind consolidation |
| Anchor refresh / single-excerpt re-derive | `<voice-anchors>` (from the changed excerpt) | ~once per chapter |
| User edits world entry / summary / title / situation | that region | user-driven; the brief's "update world-info slowly = cache friendly" |

The engine emits a `cache_break` usage event naming the region whenever a region's bytes differ
from the previous task's render, so real-world hit rates are quantifiable from `usage.jsonl`.

---

## 6. Planning-stage tools

Bound per session and registered with the harness for the high model (05 §loop). All tools are
local, synchronous, **read-only, and idempotent** — the harness may replay a planning call
after a mid-stream network death and re-obtain identical results.

| Tool | Args | Returns |
|---|---|---|
| `context_expand` | `{ kind: "section" \| "world", id, level?: "short" \| "long" \| "full" }` | The item at the requested level (default: one level above its current fidelity), wrapped with its path and a budget status line |
| `context_search` | `{ query: string, wholeWord?: boolean, scope?: { kind: "section", id } }` | Up to 20 matches: `{ kind, id, path, line, excerpt (~40 tokens around the match) }` |
| `finish_planning` | `{ cite?: ItemRef[], notes?: string }` | Ends planning; `cite` lists items the model actually relied on |

Mechanics:

- **Expand on an interior (non-leaf) section** returns its summary at the requested level
  *plus* a one-line-per-child index (`id`, `name`, token count) — the navigation path downward,
  so a model that landed on an ancestor never dead-ends. `full` on an interior section is
  interpreted as `long` + the child index (interior sections have no prose of their own — 02
  §sections).
- **Search scope**: section `content.md` files, **live snippet texts**, and **world-entry
  bodies** — everything a hit could usefully expand, including recent prose and entries demoted
  to `name`. Case-insensitive literal substring with an optional whole-word flag; a linear scan
  over a few MB is milliseconds, no index needed. This is the "grabbing precise info" case the
  brief says vector search is bad at. *Deferred:* regex (needs RE2 or sandboxing against
  catastrophic backtracking).
- **Ending planning**: two paths, both first-class — calling `finish_planning`, or responding
  with prose and no tool calls (that prose **is** the composition). The system prompt says *"if
  you already have what you need, just start writing"*; `finish_planning` exists mainly to
  carry `cite` (§7.1) and the prompt asks the model to use it when it opened anything.
- **Caps — owned solely by the engine** (the harness keeps no round counter): max
  `maxPlanningRounds = 4` planning rounds (`quick-edit`: 2), max `maxToolCalls = 10` tool calls
  per task. On a cap, `handleToolCall` returns a `planningCapReached` marker; the harness takes
  the same path as `finish_planning` (refresh turn, then composition — 05 §runner).
- **Result size**: every tool result is capped at `maxToolResultTokens = 4,096`; larger content
  is truncated with a note naming what was cut and how to narrow.
- **Budget feedback**: every `context_expand` result ends with a status line, e.g.
  `-- context: 29,400 / 32,000 soft budget; opening more will evict older items --`.
  If an expansion would push the assembly past `0.9 × hardCap`, the tool refuses:
  `"Too large to open in full (4,800 tokens). Try level:'long' (610 tokens), one of the
  children listed, or narrow with context_search."`
- **Unknown / invalid ids**: a polite error listing the nearest valid items (name prefix
  match); never an exception into the loop.
- **Un-enriched section requested at `short`/`long`** (no summary exists yet): return the full
  text if ≤ 1,500 tokens, else the first 1,500 + a note; emit `enrichment_wanted` on the
  in-process channel so the harness scheduler enqueues an enrich under its sweep cap (05
  §scheduler, 03 §in-process channels).

Each tool call is reported back to the runner (return value + label), which records it on the
run file and publishes `task.tool` ("opened Chapter 7 — full, 1,043 tok") so long plans don't
look like a hang (05 §streaming).

---

## 7. Citation tracking and decay

### 7.1 What counts as "used"

Pragmatic, zero-extra-LLM-cost rules:

1. **Opened via tool** during the task → elevated with `ttl = defaultTtl (3)`.
2. **Listed in `finish_planning.cite`** → elevated / refreshed with `ttl = defaultTtl`. This is
   the *re-cite* path: "I already had it in expanded-context and relied on it again" resets the
   clock without a redundant re-open.
3. **User-selected** in the edit-task pane (M2) → elevated, `source: "user"`,
   `ttl = defaultTtl`.
4. **Opened but omitted from an explicit cite list** → `ttl = 1` (one grace task). The penalty
   applies **only when the model provided a cite list at all** — if it never called
   `finish_planning` (the common just-start-writing path), every opened item keeps the full
   default TTL. If it listed citations, we trust the omission.

*Deferred (structured-for):* a post-hoc attribution pass where the low model scores the
generated prose against opened items. `usage.jsonl` already captures everything needed to build
and evaluate it; it is not needed to ship.

### 7.2 Decay algorithm (runs in `finalize`, once per completed task)

```
finalizeTask(session, state):
  state.taskCounter += 1

  # 1. Commit this task's opens/cites into the ledger (append or replace-in-place, §2.2).
  #    The ttl=1 penalty applies ONLY when an explicit cite list exists and excludes the item.
  citeListGiven = session.citations was provided via finish_planning
  for (ref, fidelity) in session.openedThisTask:
      ttl = (!citeListGiven || session.citations.has(ref)) ? DEFAULT_TTL : 1
      upsertElevated(ref, fidelity, ttl, lastCitedTask = state.taskCounter)
  for ref in session.citations where already elevated and not opened this task:
      elevated[ref].ttl = DEFAULT_TTL            # re-cite resets the clock
      elevated[ref].lastCitedTask = state.taskCounter
  for ref in session.userSelections (M2):
      upsertElevated(ref, selectedFidelity, DEFAULT_TTL, source="user", …)

  # 2. Progressive-penalty decay step.
  #    S assumes the next task is a plain `continue` with the current situation pane —
  #    the dominant case; only the overage bucket matters, not exactness.
  S = estimateAssembledTokens(state, assume="continue")
  overage = clamp((S - SOFT_BUDGET) / (HARD_CAP - SOFT_BUDGET), 0, 1)
  step = 1 + floor(2 * overage)                  # 1 normally; 2–3 past the soft budget
  for item in state.elevated where item.lastCitedTask < state.taskCounter:
      item.ttl -= step
  state.elevated = state.elevated.filter(i => i.ttl > 0)   # decay to default fidelity

  # 3. Hard-cap safety eviction (rare; §8.2)
  persist(state)                                 # atomic write of .cowrite/context/state.json
```

Properties: items opened in task *T* survive tasks *T+1…T+3* by default ("several actions",
per the brief); any re-open or re-cite resets the clock; budget pressure shortens everyone's
clock symmetrically, so older, less-recently-cited items fall out first — exactly the brief's
"exceeding the soft budget accelerates dropping of older items". Aborted tasks never reach
`finalize`: they neither elevate nor decay. A unit test pins the load-bearing case: *opened via
tool, composed immediately, no `finish_planning`* → `ttl = 3`, not 1.

---

## 8. Token budgets

### 8.1 Knobs and defaults

Assumption: a "big and powerful" high model with ≥128k context, where per-token cost — not the
window — is the real constraint.

| Knob | Default | Reasoning |
|---|---|---|
| `anchorTokensTotal` | 4,000 | 3–5 excerpts; with the local-context region this comfortably clears the brief's ~10k of real prose |
| `skeletonSummaryBudget` | 6,000 | ~30–60 chapters at 100–150-token shorts plus a few longs |
| `worldInfoSummaryBudget` | 3,000 | ~40 entries at name+short before largest-first demotion |
| `softBudget` | 32,000 | baseline map ≈ 17–25k ⇒ ~7–15k of free headroom (several full scenes / many entries) before penalties bite |
| `hardCap` | 64,000 | 2× soft; generous for edit tasks; ≤ 50 % of a 128k window, leaving room for the planning transcript and output |
| `defaultTtl` | 3 | "several subsequent actions" |
| decay step | 1 → 3, linear in overage | §7.2 |
| `maxPlanningRounds` / quick-edit | 4 / 2 | keeps loops snappy |
| `maxToolCalls` | 10 | per task |
| `maxToolResultTokens` | 4,096 | per result (05 consumes this cap) |
| `refreshTailTokens` | 1,000 | §5.3 |
| `targetWindowTokens` | 1,000 | each side of a frozen-section edit target (§9.2, M2) |
| `tokenMarginPct` | 10 | counts are estimates (§8.3); hence the 0.9 × hardCap line |

There is no `frontierProseTokens` knob: the local-context region's size is governed by the
consolidation thresholds in `work.json` (02 §settings) — one dial, documented on both sides.

`BudgetKnobs` lives in `packages/shared/src/context.ts` with these defaults. Override chain,
lowest to highest: schema defaults → app-level `config.budgets` (`~/.cowrite/config.jsonc`, 03
§config) → per-work `work.json → contextOverrides` (`Partial<BudgetKnobs>`, edited via
`PATCH /works/:w`). No tuning UI in MVP — profiling should pick the numbers before we build
sliders.

### 8.2 Assembly-time eviction (the enforcement backstop)

Decay is the pressure valve; eviction is the backstop when a single task overshoots (the model
opened four full chapters, or an edit-task selection is huge):

```
enforce(state, requiredRefs /* this task's user/target items */):
  S = estimateAssembledTokens(state)
  while S > HARD_CAP * 0.9:
      victims = state.elevated where ref not in requiredRefs
      if victims empty: break
      v = argmin over victims of keepScore(v)
      remove v; S = re-estimate
  if S still > HARD_CAP:            # pathological: the required selection alone is too big
      fail the task with a structured error the UI renders as
      "Selection exceeds the context limit (~71k of 64k). Deselect items or use summaries."
      (the /context/preview endpoint warns about this BEFORE launch)

keepScore(v) = v.ttl / max(1, v.tokens / 1000)   # keep fresh & cheap; evict stale & fat
               tie-break: lower elevatedAtTask evicted first (older slot first)
```

Never evicted: the local-context region, skeleton, anchors, situation, `<task>`, and the
current task's `user`/`target` items. The soft budget is **not** enforced by eviction —
exceeding it is allowed (brief requirement); it only accelerates decay and colors the tool
budget lines.

*Rejected:* a per-token "rent" score with continuous half-life decay — more elegant on paper,
harder to reason about and display. TTL-in-actions is legible in `state.json` and in the UI
("this item leaves in 2 tasks").

### 8.3 Token estimation — one estimator for the whole system

- Exact tokenization is impossible across arbitrary OpenAI-compatible backends. The engine
  standardizes on `gpt-tokenizer` (cl100k) as a *consistent estimator*; all counts are treated
  as ±`tokenMarginPct` — hence the `0.9 × hardCap` enforcement line and the "~" the UI puts in
  front of numbers.
- **The engine computes all counts itself, lazily, cached by content hash** (in-memory map,
  keyed on the `xxh64` hashes storage already maintains). No other subsystem tokenizes:
  enrichment stores no token counts, the web bundles no tokenizer, and the harness's
  `/tasks/estimate` wraps `/context/preview` and adds cost math only (05 §estimates). "The
  server computes; the web renders" — the edit-task meter and pre-launch estimate cannot
  disagree because they are the same number.
- Elevated items cache their count in the ledger (`ElevatedItem.tokens`) and re-estimate at
  `beginTask` whenever `sourceHash` no longer matches the snapshot (§10).
- The first `/context/candidates` call on a large work pays a one-time tokenization pass
  (~1 s for a novel); the hash cache makes every subsequent call cheap.

### 8.4 Usage log (profiling hook)

One JSONL line per event, `.cowrite/context/usage.jsonl`:

```ts
export const UsageEvent = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("task_start"), task: z.number(), taskKind: TaskKind,
             assembledTokens: z.number(),
             regions: z.record(z.string(), z.number()), ts: IsoTime }),
  z.object({ kind: z.literal("tool_call"), task: z.number(), tool: z.string(),
             item: ItemRef.optional(), resultTokens: z.number(), ts: IsoTime }),
  z.object({ kind: z.literal("task_end"), task: z.number(),
             cited: z.array(ItemRef), decayed: z.array(ItemRef), evicted: z.array(ItemRef),
             finalTokens: z.number(), planningRounds: z.number(), ts: IsoTime }),
  z.object({ kind: z.literal("cache_break"), task: z.number(), region: z.string(),
             ts: IsoTime }),
]);
```

---

## 9. One engine, four interactive task kinds

The engine is task-kind-agnostic; kinds differ only in what fills `<task>`, what the bottom
region is, and which items are pre-elevated. Background kinds (`enrich-section`,
`propose-boundaries`) and illustration kinds never open a session — their prompt assembly is
handler- or pipeline-owned (05 §background assembly), and the ledger is untouched by background
work.

| Kind | `<task>` | Bottom region | Pre-elevations | Planning cap |
|---|---|---|---|---|
| `continue` | standing continue directive | `<local-context>` | — | 4 rounds |
| `instructed-continue` | user instruction, instruction-marked | `<local-context>` | — | 4 rounds |
| `quick-edit` | short instruction + selection excerpt | `<local-context>` (snippet target marked in place) | target's section neighbours n/a in M1 | 2 rounds |
| `edit-task` (M2) | long instruction | `<target>` (frozen-section targets) or `<local-context>` (snippet targets) | pane selections (`user`), targets + adjacent siblings (`target`) | 4 rounds |

### 9.1 Quick edit (M1)

The target is **one snippet** (05 §taxonomy validates this at `POST /tasks`). Snippets are
always inside `<local-context>` at full text, so no window machinery is needed: the engine
marks the target snippet and the user's selection in place (marker tags per 07), and the
instruction + selection excerpt travel in `<task>`. The skeleton, anchors, and world regions
are identical to a `continue` — cache-friendly by construction.

### 9.2 Targets behind the frontier (M2: quick-edit spans, edit-task)

For a target inside a frozen section ("far" ≝ not among the un-consolidated snippets):

- **The skeleton stays frontier-relative.** Re-centering rules 3–5 on the target would rewrite
  `<global-context>` for one task and back — a full cache miss twice for zero benefit, since
  elevations already carry the target's surroundings.
- The target section is elevated to `full` and its adjacent siblings to `long`
  (`source: "target"`, `ttl = 1`), rendered in `<expanded-context>` as normal.
- A `<target>` region is appended **below `<local-context>`**: the target span plus
  `targetWindowTokens` (1,000) of surrounding prose on each side, selection marked. The region
  the model must write against sits nearest the generation point, satisfying the brief's
  bottom-placement rule for the editing case; `<local-context>` still precedes it so recent
  voice remains in context.
- Edit-task pane selections arrive in the spec (`contextSelections` on the `edit-task`
  `TaskSpec` variant, 05 §specs), are validated against the current `/candidates` set at
  `POST /tasks` (`400 validation` for unknown refs or unavailable fidelities), and enter the
  ledger as `source: "user"` at finalize.

### 9.3 Session API (the surface 05 drives)

```ts
// apps/server/src/context/engine.ts
export class ContextEngine {
  static async load(work: WorkHandle, deps: EngineDeps): Promise<ContextEngine>;
  /** Interactive TaskSpecs only; throws SessionBusyError if a session is open
   *  (defensive — 05's interactive-lane capacity of 1 plus the background bypass
   *  make it unreachable in practice). */
  beginTask(spec: TaskSpec): TaskContextSession;
  candidates(): ContextCandidate[];              // GET /context/candidates
  preview(req: PreviewRequest): PreviewResponse; // POST /context/preview
  reset(): Promise<void>;                        // POST /context/reset
}

export interface TaskContextSession {
  /** Ordered region render + tool defs + the ContextSnapshot for the run's meta event. */
  assembleInitialPrompt(): { messages: ChatMessage[]; tools: ToolDef[];
                             snapshot: ContextSnapshot };
  /** Read-only and idempotent (replay-safe for the harness's retry ladder). */
  handleToolCall(call: ToolCall): Promise<ToolResult>;
  compositionRefreshTurn(): string | null;       // §5.3; null if no tools were used
  finalize(outcome: "completed"): Promise<void>; // citations → ledger, decay, evict, persist
  abort(): void;                                 // discard session state; no side effects
}

export interface EngineDeps {                    // everything injected = everything mockable
  manuscript: ManuscriptReader;   // section tree, content, summaries, snippets (02 readers)
  worldInfo: WorldInfoReader;
  situation: SituationReader;     // getSituation() (02 §situation)
  channels: {                     // in-process EventBus channels (03 §in-process channels)
    emitEnrichmentWanted(sectionId: Ulid): void;
    onEnrichmentCompleted(cb: (sectionId: Ulid) => void): Unsubscribe;
  };
  onUsage?: (e: UsageEvent) => void;   // teed to usage.jsonl by the engine; exposed for tests
  knobs?: Partial<BudgetKnobs>;
  now?: () => Date;
}
```

The runner's lifecycle contract (05 §runner): `beginTask` → `assembleInitialPrompt` → planning
rounds via `handleToolCall` → `compositionRefreshTurn` → composition → **`finalize("completed")`
on success, `abort()` on every error/cancel path** — the ledger only ever moves on completed
tasks. The `ContextSnapshot` (schema in `packages/shared/src/runs.ts`, owned by 05; values
produced here) lists every region with its token count and every item with
`{id, kind, fidelity, tokens, source}` — the typed feed for the provenance viewer's "Prompt
(8 regions, 6.4k tokens)" view and the usage log's `regions` record. The situation and anchor
items use the work id / source section id respectively as their `id`.

---

## 10. Snapshot isolation (concurrent background work)

Enrichment, consolidation, and the reconciler run continuously in the background (02, 05). If
their writes were visible mid-task, a `context_expand` result could contradict the summary
already in the prompt, an anchor refresh could invalidate the prefix between planning rounds,
and token counts could shift under the eviction math. Policy, enforced in `beginTask`:

> The session snapshots the section tree, summaries, snippet list, world entries, situation,
> anchors, and token counts at `beginTask`. All change notifications arriving during the task —
> `enrichment.completed`, storage `onChange`, anchor staleness — are **queued and applied at
> the next `beginTask`**. Within one task, every read is served from the snapshot.

Cheap to implement (the readers are injected; the snapshot is a shallow copy of metadata plus
lazy content reads pinned by hash) and it makes the golden-prefix tests in §12 reflect runtime
behavior. The reconciler runs before every agent run (02 §reconciler), so the snapshot is never
staler than the task that uses it. Consolidation staging (consumed snippets move out of
`frontier/` atomically at apply, 02 §apply) guarantees the snapshot never sees the same prose
as both snippets and a section.

At `beginTask`, before the snapshot freezes, the engine also reconciles its own state:

- **Elevated-item staleness**: any `ElevatedItem` whose `sourceHash` differs from the
  snapshot's hash is re-rendered and re-estimated (hash cache, §8.3); the resulting byte change
  is attributed with a `cache_break: expanded-context` event. Items whose source was deleted
  (section removed externally, entry deleted) are dropped from the ledger.
- **Anchor staleness**: per-excerpt hash check, single-excerpt re-derive (§4.3).
- **Queued events**: chapter-enrichment completions trigger the full anchor refresh;
  consolidation events re-run the default map (they would anyway — the map is computed fresh
  each task).

---

## 11. REST surface

All under `/api/works/:w/context`, mounted by the API layer (03 §context routes), all M1:

| Method & path | Purpose |
|---|---|
| `GET /context/state` | Current `ContextState` + the computed default fidelity map (debug pane; edit-task initial checkmarks in M2) |
| `GET /context/candidates` | Flattened section tree + world list; per item `{ id, kind, name, path, defaultFidelity, currentFidelity, tokens: { name?, short?, long?, full? } }` (absent fidelities omitted — e.g. no summary yet) |
| `POST /context/preview` | `{ taskType, selections: [{id, kind, fidelity}], targets?: ItemRef[] }` → `{ totalTokens, perRegion, overSoft, overHard, softBudget, hardCap }` — a dry-run assembly with the selections overlaid; powers the live token meter and the pre-launch over-hard-cap warning. The response carries the effective `softBudget`/`hardCap` (after per-work `contextOverrides`) so the meter's scale is entirely server-fed |
| `POST /context/reset` | Wipe ledger + anchors back to defaults (troubleshooting; emits `cache_break` for every region) |
| `GET /context/usage?limit=100` | Recent `UsageEvent`s (profiling view) |

`POST /tasks/estimate` (M2) is the harness's wrapper over `/context/preview` — cost math only,
no second estimator (05 §estimates). Task execution endpoints belong to 03/05; the harness
calls the engine in-process.

DTOs (`packages/shared/src/context.ts`):

```ts
export const ContextCandidate = z.object({
  id: Ulid,
  kind: ItemKind,
  name: z.string(),
  path: z.string(),                 // ancestor names joined by " › "
  defaultFidelity: Fidelity,
  currentFidelity: Fidelity,        // default unless elevated
  tokens: z.partialRecord(Fidelity, z.number().int()),
});

export const PreviewRequest = z.object({
  taskType: TaskKind,               // interactive kinds only; others → 400 validation
  selections: z.array(z.object({ id: Ulid, kind: ItemKind, fidelity: Fidelity })).default([]),
  targets: z.array(ItemRef).default([]),
});

export const PreviewResponse = z.object({
  totalTokens: z.number().int(),
  perRegion: z.record(z.string(), z.number().int()),
  overSoft: z.boolean(),
  overHard: z.boolean(),
  softBudget: z.number().int(),     // effective values after per-work contextOverrides —
  hardCap: z.number().int(),        //   the meter's scale is server-fed, no client constants
});
```

---

## 12. Failure modes

| Failure | Behavior |
|---|---|
| `state.json` missing / corrupt / old schema | Regenerate defaults, log a warning, emit `cache_break` for all regions. It is a cache; the manuscript is truth. |
| Model never stops planning | Round/tool caps force composition (§6); the harness takes the refresh-turn path |
| Model opens something enormous | Tool refuses past `0.9 × hardCap`, suggests `long`, children, or search (§6) |
| Model cites an unknown ref | Ignored + logged; never fails the task |
| Edit-task selection alone exceeds the hard cap | Structured task failure (§8.2); `/context/preview` warns before launch |
| Un-enriched section expanded at `short`/`long` | Serves full text ≤ 1,500 tokens (else truncated + note); emits `enrichment_wanted` (§6) |
| Enrichment / consolidation lands mid-task | Queued; applied at the next `beginTask` — the running task's snapshot is immutable (§10) |
| Anchor source text edited | Per-excerpt hash mismatch at `beginTask` → single-excerpt re-derive in place (§4.3) |
| Elevated item's source edited / deleted | Re-render + re-estimate at `beginTask` (attributed `cache_break`); deleted sources drop from the ledger (§10) |
| Task aborted / cancelled / crashed | `abort()`: no elevation, no decay, no `taskCounter` bump; `state.json` untouched |
| Planning call replayed after a stream death | `handleToolCall` is read-only + idempotent — identical results, no double elevation (§6, 05 §retries) |
| Token estimates drift from provider truth | ±10 % margin + hard cap ≤ 50 % of the model window keeps failures theoretical; provider context errors surface as ordinary task failures |
| Second `beginTask` while a session is open | `SessionBusyError` — defensive; unreachable under 05's lane rules (interactive capacity 1, background bypass) |

---

## 13. Testability

- **Pure core**: `defaults.ts`, `anchors.ts`, `assemble.ts`, `decay.ts` are pure functions of
  `(snapshot, ledger, knobs)` — table-driven Vitest units. Decay/eviction get exhaustive
  small-case tests: TTL math, overage steps, eviction order determinism, and the pinned
  regression *opened-composed-immediately-no-finish_planning ⇒ ttl = 3*.
- **Golden prefix tests** (the cache contract): assemble for state A; elevate one item;
  reassemble; assert a byte-identical prefix through `<voice-anchors>` and that the change is a
  pure append inside `<expanded-context>`. Repeat across a simulated frontier-growth task, a
  consolidation event (skeleton + local-context change only), and a single-anchor re-derive.
  These goldens are the regression fence for cache-friendliness, and they pair with the
  harness's golden-prefix request test (05 §mock strategy).
- **Property tests** (random trees/ledgers): post-`enforce` estimate ≤ hardCap; every section
  present at ≥ `name` and every live snippet at `full` in every assembly (the coverage
  invariant); decay is monotone; ledger round-trips through `state.json`; `handleToolCall`
  called twice with the same args returns identical bytes.
- **Agent-loop integration**: `packages/mock-llm` scenarios scripted to emit
  `context_expand → context_search → finish_planning`; assert ledger contents, TTL values,
  usage events, snapshot contents in the run `meta`, and the refresh turn (shared scenario
  fixtures with 05/09).
- **e2e (Playwright)**: M1 — `/context/preview` totals render in the provenance/debug surfaces;
  M2 — the edit-task pane meter matches `/preview` exactly (same server number) and launched
  selections appear cited in `/context/state`.

---

## 14. MVP cut

**M1** — the context engine's full loop, everything the flagship frontier tasks need:

- Fidelity model, ledger, `.cowrite/context/state.json` persistence, default-map computation
  with the total-coverage invariant (all live snippets full; un-enriched frozen sections full)
- Voice anchors: positional stratification, pinning, per-excerpt hash staleness,
  `enrichment.completed`-driven refresh
- Prompt assembly with stability ordering, `<expanded-context>` append region, composition
  refresh turn, `ContextSnapshot` production
- Tools: `context_expand` (incl. child index), `context_search` (sections + snippets + world),
  `finish_planning` with `cite`; engine-owned planning caps and result caps
- Citation tracking, TTL decay with overage acceleration, hard-cap eviction
- Sessions for `continue`, `instructed-continue`, `quick-edit` (single-snippet targets);
  snapshot isolation with queued background events
- Token estimator (`gpt-tokenizer` + hash cache) — the system's only tokenizer
- All five `/context/*` routes (incl. `/preview` for the meter), `usage.jsonl`

**M2:**

- `edit-task` sessions: `contextSelections` validation + `user` elevations, multi-target and
  frozen-section-span support, the `<target>` region and target/sibling pre-elevations (§9.2)
- `quick-edit` on intra-section spans (same `<target>` machinery)
- `/tasks/estimate` integration (harness wrapper; engine side is `/preview`, already M1);
  edit-task pane consumption of `/candidates`

**Structured-for, deferred beyond M2:**

- Low-model post-hoc attribution pass (usage log already captures its training data)
- Regex search (RE2), search-result ranking
- Anchor mood/dialogue-ratio scoring (pure stratification ships; the scorer slots into
  `anchors.ts` behind the same interface)
- Persistent user pins ("always include this entry") — `ElevationSource` has room
- Budget-tuning UI and a profiling dashboard over `usage.jsonl` (JSON overrides only in MVP)
- Cross-work world-info sharing

---

## 15. Contracts

Shared schemas this subsystem **owns** (`packages/shared/src/context.ts`):

| Schema | Consumers |
|---|---|
| `Fidelity`, `FIDELITY_ORDER`, `ItemKind`, `ItemRef` | 05 (`ContextSelection`, `ContextSnapshot` items), 03 §context routes, 04 §edit-task pane |
| `ContextState`, `ElevatedItem`, `AnchorExcerpt` | `GET /context/state`; on-disk `state.json` |
| `BudgetKnobs` | 03 §config (`config.budgets`), 02 (`work.json → contextOverrides`) |
| `ContextCandidate`, `PreviewRequest`, `PreviewResponse` | 03 §context routes, 04 §edit-task meter, 05 §estimates (`/tasks/estimate` wrapper) |
| `UsageEvent` | `usage.jsonl`, `GET /context/usage` |
| Session API (`ContextEngine`, `TaskContextSession`, `EngineDeps` — `apps/server`) | 05 §runner (lifecycle: `finalize` on success, `abort` otherwise; `handleToolCall` read-only/idempotent; caps owned here) |

Values this subsystem **produces** against schemas owned elsewhere:

| Contract | Owner | Produced where |
|---|---|---|
| `ContextSnapshot` | 05 (`runs.ts`) | `assembleInitialPrompt` → run `meta` event → 04 §provenance region view |

Shared schemas and services this subsystem **consumes**:

| Contract | Owner | Used for |
|---|---|---|
| `TaskSpec` / `TaskKind` (interactive variants incl. `edit-task.contextSelections`) | 05 §specs | `beginTask` input; per-kind assembly (§9) |
| Storage readers: section tree + `getSectionContent`, summaries, `listSnippets` + texts, world entries, `getSituation`; content hashes | 02 §StorageService | snapshot capture (§10), rendering, search corpus |
| Consolidation thresholds (`maxFrontierWords` etc.) | 02 §settings | the local-context size bound (§4.1 rule 1) |
| `enrichment_wanted` (emit) / `enrichment.completed` (subscribe) in-process channels | 03 §in-process channels | un-enriched expands (§6); anchor refresh (§4.3) |
| `config.budgets` + `work.json.contextOverrides` override chain | 03 §config, 02 §work | knob resolution (§8.1) |
| Region tag grammar, marker tags, `<instructions>` template wording | 07-prompting.md | this doc owns region *ordering* and contents; 07 owns the markup |

Cross-subsystem touchpoints: the reconciler runs before every agent run (02 §reconciler), so
`beginTask` snapshots reconciled state; consolidation's staging rule (02 §apply) is what keeps
snapshots double-text-free; the harness publishes tool activity as `task.tool` `WorkEvent`s (03
§SSE) from the values `handleToolCall` returns — the engine itself never touches HTTP or SSE.

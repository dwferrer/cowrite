# Critique — Illustration Pipeline (docs/design/illustration.md)

**Reviewed against:** `docs/00-overview.md` (treated as the authoritative brief, matching the
proposal's own provenance note — the brief path supplied to this review also resolved to
`undefined`), plus the sibling designs it cites (`agent-harness.md`, `data-model.md`,
`context-engine.md`). Cross-references to harness §13.5 (RunContext, 10-minute total timeout,
illustration lane capacity 1), data-model §13.5 (`writeEnrichment`, one-image-per-section atomic
overwrite), the `world_keys` index, and the `<image-prompt>` tag block were all verified and are
accurate.

Overall the proposal is one of the stronger docs in the set: the marker convention is
well-argued, the mock/test plan is concrete, and the MVP cut is mostly disciplined. The issues
below are ordered by severity.

---

## Major issues

### M1. [major] The "brief assumes <20 s/image" claim is fabricated — and load-bearing

§2.4 justifies `execTimeoutMs = 120 000` with "brief assumes <20 s/image; 6× headroom", and §4.5
is headlined "assumes <20 s/image, per the brief". The brief (`00-overview.md`) contains **no
such number** — no per-image latency assumption appears anywhere in it. This matters because
three design decisions are anchored to it: the timeout ladder, the `maxAttempts = 3` reasoning
("3 attempts bound the background task near a minute"), and the §6 candidates-discarded rationale
("regeneration is <20 s"). On a mid-range local GPU an SDXL image is routinely 30–90 s, at which
point the worst-case loop is 5+ minutes, the "lane drains faster than chapters freeze" argument
weakens, and "just regenerate a discarded candidate" stops being cheap.

**Fix:** Delete the false citations. State the latency figure as an explicit *assumption of this
design* with the observed range it must tolerate, and re-derive `maxAttempts`/timeout defaults
from the pessimistic end (the per-workflow `execTimeoutMs` override already helps — say so here).

### M2. [major] Worst-case internal timeout budget exceeds the harness's 10-minute cap, and a timeout discards an already-scored winner

Per §2.4, one `generate` can legally consume `queueTimeoutMs (90 s) + execTimeoutMs (120 s)` ≈
210 s. Three attempts is 630 s before adding compose/critique/revise calls (low-lane
`totalTimeoutMs` is 120 s each per harness §6.3) and the once-retried `execution_error` path
(§10), which re-runs a full generate inside one attempt. That exceeds the harness's 600 s total
timeout, so the *harness* kills the run mid-attempt-3. Because candidates are memory-only and
commit happens only after the loop (§4.1, §6), the abort throws away attempt 1's perfectly good
scored image — a genuine lose-work path: the user waited ten minutes and got nothing, when a
6/10 image was in hand at t=90 s.

**Fix:** Two small changes: (a) before starting attempt *n+1*, check remaining run budget against
a pessimistic single-attempt estimate and skip to best-of commit if it doesn't fit; (b) on
harness-timeout (as distinct from user cancel), commit the best attempt so far instead of
dropping everything. User cancel keeping the discard semantics is fine.

### M3. [major] Delete-with-suppression contradicts itself — implementers must guess the on-disk shape

§5 override path 3: delete "removes the PNG and **nulls the enrichment metadata**" and, in the
same sentence, "deletion sets `suppressed: true` **in the metadata slot**". Both cannot be true:
a nulled slot has no `suppressed` field. Worse, `IllustrationMeta` (§6) cannot represent a
tombstone — `generatedAt: IsoTime` is non-nullable and `attempts.min(1)`, so a
`{ suppressed: true }`-only record fails Zod validation. Data-model §10 defines the slot as
`EnrichmentMeta.extend({prompt}).nullable()`; this doc supersedes it (§13.2a) but never defines
the deleted-but-suppressed state. The staleness sweep's "skip suppressed" rule (§13.2d) is
unimplementable until this is pinned down.

**Fix:** Define the slot as a discriminated union, e.g.
`null | IllustrationMeta | { suppressed: true, deletedAt: IsoTime }`, and state which shape each
transition writes (generate → meta; delete → tombstone; "Illustrate" menu → clears tombstone
before enqueue).

### M4. [major] The established-imagery lookup is defeated by the composer's own no-names rule

§4.2 sources "established imagery" from "accepted image prompts of previous illustrations **that
mention any matched entity**" — i.e., text-matching entity names against stored prompt strings.
But composer rule 5 instructs the model to *replace* names with physical descriptions ("render
'Mara Voss' as her physical description"), with the name at most optionally decorative. A
rule-following composer produces prompts that don't contain the names the lookup searches for, so
the consistency mechanism (§7 nudge 2 — one of only three consistency mechanisms in the whole
design) silently finds nothing after the first section. The better the composer follows the
rules, the worse consistency gets.

**Fix:** Don't text-match prompts. Record the matched world-entry ids in `IllustrationMeta` at
compose time (e.g. `entities: Ulid[]`) and look up established imagery by entity id. This also
makes the `listIllustrationMetas(workId)` scan (§13.2c) a cheap filter instead of substring
matching, which matters on a 300k-word work with hundreds of sections.

### M5. [major] "Unique image-producing output node" detection is unspecified and not derivable from the workflow JSON

§2.2 validation requires: "if multiple nodes produce `images` outputs, `%output%` must
disambiguate; with a single `SaveImage`-like node the marker is optional." API-format JSON
contains only `class_type` and `inputs` — **it does not describe node outputs**. Whether a node
produces images is knowable only from a class whitelist (`SaveImage`, `PreviewImage`, …plus any
custom save node the user installed) or from querying ComfyUI's `/object_info` — which §2.1
explicitly excludes ("exactly the stable, documented subset… Nothing else"). "SaveImage-like" is
undefined. An implementer must guess, and the guess determines both startup validation and the
`h.outputs[req.outputNodeId]` fetch in §2.3. A user with a custom save node and no `%output%`
marker gets either a false startup failure or a wrong-node fetch at runtime.

**Fix:** Pick one and write it down. Cheapest consistent option: a small built-in class whitelist
(`SaveImage`, `PreviewImage`, `SaveImageWebsocket`) for the no-marker case, plus a documented
rule that any other topology **requires** `%output%`; validation error message says so. As a
runtime backstop, if `h.outputs[outputNodeId]` is empty but exactly one other node has images in
history, use it and log a warning.

### M6. [major] `illustration_stale` cannot be rebuilt from files — brief principle 3 violation

Brief: "**Files are the truth.** Any state the app can't rebuild from the work directory is a
bug." Data-model §6.5 defines illustration staleness as "word count of the section changes by
**>15%**" relative to generation time. `IllustrationMeta` (§6) stores only `sourceHash`. A hash
tells a rebuilt index *that* the content changed, not *by how much* — after an index rebuild (or
an external edit picked up by the reconciler) the 15% rule is uncomputable, so `illustration_stale`
degenerates to any-change-is-stale, silently re-illustrating sections after trivial typo fixes
and burning GPU time.

**Fix:** Add `sourceWordCount: number` (nullable for world images) next to `sourceHash` in
`IllustrationMeta`. One integer restores derivability.

---

## Minor issues

### m1. [minor] Accept-verdict dead zone between 6 and `acceptScore`

§4.1 breaks on `verdict == "accept" && overall >= acceptScore (7)`; §4.3's guard rail overrides
to `revise` only when `accept && overall < 6`. An `accept` with overall 6.0–6.9 neither breaks
nor is overridden: the loop calls `revise()` feeding it a critique whose verdict is "accept" and
whose `promptAdvice` may be empty or perfunctory — a wasted revision round steering on nothing.
**Fix:** collapse to one rule: treat any non-breaking outcome as `revise` and require the guard
rail (or the repair retry) to ensure `promptAdvice` is non-empty when the loop will continue.

### m2. [minor] Registry schema doesn't validate `route` keys; the `workflows` refine is a no-op

`route` defaults to `{section: "default", world: "default"}`, but nothing checks that the named
keys exist in `workflows` — a user who defines only `"portrait"` gets a runtime failure on first
illustration instead of a startup `workflow_invalid`. And the refine
`w => "default" in w || Object.keys(w).length > 0` passes *any* non-empty record, so it enforces
nothing the `record` type doesn't already. **Fix:** cross-field refine (or registry-load check)
that both `route.section` and `route.world` name existing workflow entries; delete or fix the
vestigial refine.

### m3. [minor] The §4.1 loop pseudocode has no failed-attempt branch

§10 says a twice-failed `execution_error` "fails the *attempt*" and "the loop still tries
remaining attempts", but the pseudocode unconditionally does `crit = critique(...)` and
`revise(lowClient, brief, prompt, crit)` — with what `crit` after a failed attempt? Does a failed
attempt count against `maxAttempts`? Reuse the same prompt or re-revise from the last successful
critique? **Fix:** add the branch to §4.1 (suggest: failed attempt consumes a slot, prompt
carries over unchanged, no revise call).

### m4. [minor] Fallback `content.md` truncation strategy unspecified

§4.2 falls back to "content.md, truncated" at ~3 000 tokens. A frozen chapter can be 5 000+
words; head-truncation biases the "one concrete visual moment" to the chapter opening,
tail-truncation to the ending. **Fix:** one sentence — e.g. first ~1 000 + last ~2 000 tokens
with an ellipsis marker, or just say "head" and accept the bias knowingly.

### m5. [minor] Full-resolution PNG shipped to the VLM as base64 — cost/latency claim optimistic

§4.3 attaches the raw generated PNG (a 1216×832 SDXL PNG is commonly 1.5–3 MB → ~2–4 MB of
base64) to every critique call, and §4.5 budgets "2–4 k prompt tokens" per call. Vision token
counts and request-size limits on small self-hosted OpenAI-compatible servers vary widely; some
cap request bodies below this. Since `sharp` is already a dependency (§10 transcode row),
downscaling to ~768 px longest side before critique costs nothing and shrinks payloads ~4×
without hurting a 0–5 rubric judgment. **Fix:** downscale before attach; note it in §4.3.

### m6. [minor] Section restructured or deleted during the run — missing failure-mode row

The loop runs ~30–300 s while consolidation/boundary tasks (data-model) can merge, split, or
re-slug sections. §10's table has no row for "commit target no longer exists". `writeEnrichment`
presumably throws, but the *policy* (fail run quietly? re-resolve the section?) is unstated.
**Fix:** add the row: commit-time miss ⇒ run fails quietly to the activity log, no retry (the
scheduler will re-enqueue for whatever section now owns that text via normal staleness).

### m7. [minor] `GET /api/illustration/workflows` has no MVP consumer

§8 ships an endpoint "for future pickers" while §3 explicitly rejects a workflow picker for MVP
and §12 defers it. An endpoint nobody calls is exactly the premature generality the brief strips
("simple, modern… stripped of fiddly legacy features") — and the data it would serve already
appears in `GET /api/illustration/health`'s `workflows` array. **Fix:** cut it; add it back with
the picker.

---

## What was checked and found sound (no action)

- Node-title `%marker%` convention and its rejected alternatives — the argument is correct and
  the mandatory-`%seed%` rationale (result-cache short-circuit) is a real ComfyUI behavior.
- "/history is truth, WS is progress" with polling fallback — right shape; degrades, never fails.
- Best-of with early accept vs. last-is-best / multi-image side-by-side — correct call, correctly
  argued (multi-image messages genuinely are the least portable VLM corner).
- Harness-guest posture (no parallel task API, no context-engine session, low-lane-only images)
  matches harness §3.2/§6.1/§13.5 and brief principles 1–2 exactly.
- Candidates-discarded, one-image invariant, suppression concept (modulo M3), upload pinning —
  good MVP discipline; mock ComfyUI + tEXt-chunk assertion trick is a genuinely good test design.
- All §13 cross-doc extension flags are real deltas, correctly identified as needing sign-off.

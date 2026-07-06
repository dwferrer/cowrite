# Adversarial Review: Smart Context Management Engine

Proposal reviewed: `/home/user/cowrite/docs/design/context-engine.md`
Brief: `docs/design-notes/brief.md`
(the orchestrator passed the brief/output paths as `undefined`; the brief was located in the
session scratchpad and this critique is written next to it).

Overall: the architecture is fundamentally sound — stability-ordered regions with an append-only
`<expanded-context>`, a TTL ledger, plain-text search, one engine for four task types, and a
disciplined MVP cut all match the brief well. But there is one hole in the default-fidelity rules
that breaks the flagship "continue" flow on real works, a normative-algorithm contradiction that
would silently violate the brief's decay requirement, and several cache/consistency claims that
don't hold as written.

---

## 1. [blocker] Prose between the 6k frontier window and the last enriched section can vanish from the prompt entirely

**What's wrong.** §4 rule 1 takes trailing prose "until `frontierProseTokens` (6,000) is
consumed." Rules 2–4 then assign *summaries* to "finished" sections before the window. Nothing
covers text that is (a) older than the 6k window but (b) not yet consolidated/enriched — i.e. the
first half of the chapter currently being written, or any section where background enrichment lags.
The brief's own data model guarantees this state exists: "There's no point summarizing a chapter
until the chapter has been finished," and consolidation happens only "once the frontier has moved
sufficiently far past" snippets. So on any work where the active chapter exceeds ~6k tokens (which
is routine — chapters in a 100k–300k-word novel run 3k–10k tokens), the opening of the current
chapter is in *no* region: not raw prose, not summary, not even a name. The model will contradict
events from two scenes ago, in the worst possible place — right behind the frontier. §11's
"un-enriched far section requested" row handles only the tool path, not default assembly.

**Secondary contradiction in the same rules.** §5.1 claims `<global-context>` "stays
byte-identical across tasks (until a chapter freezes or a summary is edited)," but rules 2–3 are
frontier-relative: the identity of "the 2 chapter-level sections immediately before the window"
and the "same parent" sibling set changes as the window slides, and a section can be *half* inside
the window (the rules never say what fidelity a partially-covered section gets). Either the skeleton
recomputes per task (breaking the stability claim) or it doesn't (breaking rules 2–3).

**Fix.** Make the frontier window elastic, not fixed: it must extend backward to cover *all*
text that has no substitutable summary yet (all live snippets plus any un-enriched trailing
sections), with 6k as the *target* once enrichment has caught up. Define the window boundary as
the nearest enriched-section boundary at or before the 6k mark, so sections are always wholly in
or wholly out — this simultaneously fixes the half-section ambiguity and makes `<global-context>`
change only at consolidation events, rescuing the stability claim. State explicitly that the
window may exceed 6k when enrichment lags and that this is the intended behavior. Also specify
the degenerate bootstrap: a work with no enrichment anywhere is 100% window (up to hard-cap
handling), since §4's "chapter-level" definition ("deepest level enrichment has produced summaries
for") is undefined when no summaries exist.

## 2. [major] The finalize pseudocode gives opened items ttl=1 in the stated common case, contradicting §7.1 and the brief

**What's wrong.** The brief: elevated items decay "back to summaries after several actions," and
the proposal's own §7.1 rule 1 says opened-via-tool ⇒ `ttl = defaultTtl (3)`, with rule 4's
ttl=1 penalty applying only when the model "listed citations at all" and omitted the item. But the
normative pseudocode in §7.2 is:

```
upsertElevated(id, fidelity, ttl = citedThisTask(id) ? DEFAULT_TTL : 1, ...)
```

`citedThisTask` can only be true if the model called `finish_planning` with a `cite` list. §5.3
and §6 say the common path — especially plain "continue" — is that the model *never* calls
`finish_planning` (it "just starts writing"). In that path `citations` is empty, so **every**
opened item gets ttl=1 and decays after a single action. An implementer following the pseudocode
(the thing they'll actually translate to code) ships behavior that violates both §7.1 and the
brief's "several actions."

**Fix.** One line: `ttl = (session.citations.isEmpty() || session.citations.has(id)) ? DEFAULT_TTL : 1`
— i.e., the ttl=1 penalty applies only when an explicit cite list was provided and excludes the
item. Add a decay unit test pinning the "opened, composed immediately, no finish_planning" case
to ttl=3.

## 3. [major] World-info demotion keyed on "least recently cited (per ledger history)" is neither computable nor cache-safe

**What's wrong (two ways).** §4 rule 5 demotes overflow world-info entries "starting from the
least recently cited (per ledger history)." (a) The ledger deletes items when they decay
(`state.elevated.filter(i => i.ttl > 0)`), so citation recency for any non-elevated entry — the
very entries being ranked for demotion — is *not present* in `ContextState`. An implementer must
invent a data source (scan `usage.jsonl`? add a hidden map?). (b) Even if the data existed, the
demotion set would change as citation recency changes, i.e., per task — and `<world-info>` is the
*second region from the top* of the prompt (§5.1). Exactly on the works where demotion triggers
(world-info summaries > 3k tokens), the near-top region churns every few tasks and invalidates
almost the entire cached prefix. This defeats the proposal's own "most stable content earliest"
rule and the brief's "If we update world-info slowly, this is also quite cache friendly."

**Fix.** Demote by a *static* order (entry creation order, matching the region's declared sort),
recomputed only when world-info is edited or an entry is created/deleted. Recency-aware demotion
isn't needed: recently-used entries are already elevated in `<expanded-context>` via the ledger, so
demoting their skeleton `short` to `name` loses nothing. If recency ordering is truly wanted later,
it needs a persisted `lastCited` map plus an explicit rule that the demotion set is frozen between
world-info edits — but static order is simpler and strictly more cache-friendly.

## 4. [major] No coherence rule for background enrichment running concurrently with a task

**What's wrong.** The overview/brief make enrichment a background process ("gets enriched in the
background"), and this design consumes its outputs everywhere: summaries, per-fidelity token
counts, the "chapter finished" event that triggers anchor refresh (§4.1), and section freezes that
rewrite `<global-context>`. Yet nothing says what happens when enrichment lands *mid-task*: a
`context_expand` tool result could serve a summary inconsistent with the one already assembled
into the prompt; an anchor refresh could fire between planning rounds; token counts used by the
budget lines and eviction could shift under the session. §11 covers concurrent *tasks*
(`SessionBusyError`) but not the enrichment subsystem, which by design is always running.

**Fix.** One sentence of policy, enforced in `beginTask`: the engine snapshots the manuscript
tree, summaries, token counts, and anchor set at `beginTask`; all enrichment events (including
anchor-refresh triggers and freezes) are queued and applied at the *next* `beginTask`. Cheap to
implement (the readers are already injected via `EngineDeps`) and it makes the golden-prefix tests
in §12 actually reflect runtime behavior.

## 5. [major] Anchor staleness detection has no stored hash, and char-range excerpts break on any edit

**What's wrong.** §11 promises "Content-hash check at assembly; stale anchor triggers a refresh of
just that excerpt," but the `ContextState.anchors.excerpts` schema (§2.2) stores only
`{id, sectionId, start, end, tokens, moodTag}` — no hash to check against. Worse, `start`/`end`
are character offsets into the section's markdown: *any* edit earlier in the section shifts the
range, so the check (once a hash field is added) will fire on edits that didn't touch the excerpt
at all, and without a hash the engine would silently serve garbled mid-word slices. The brief
explicitly lets users edit anything at any time.

**Fix.** Add `contentHash` (hash of the excerpt text, or of the whole section source) to the
excerpt schema. On mismatch, re-derive the excerpt: re-run the §4.1 selection for that one span
against the edited section (or re-anchor by searching for the old excerpt's first paragraph).
State that a refreshed excerpt keeps its position in `<voice-anchors>` so only that region
invalidates.

## 6. [minor] `context_search` scope is underspecified in ways that matter

§6 says search is "scanned over the section markdown files." That excludes (a) frontier snippets
not yet consolidated — combined with issue 1, recent-but-out-of-window text would be both invisible
and unsearchable — and (b) world-info bodies, even though the brief's stated motivation for text
search is "grabbing precise info," which for character facts usually lives in world-info, and
rule 5 can demote entries to name-only (making their content otherwise undiscoverable). The result
shape (`sectionId` only) also can't represent a snippet or wi hit. **Fix:** specify that search
covers sections + live snippets + world-info bodies, and return `{ id (sec_|snip_|wi_), path,
excerpt }` so `context_expand` can follow up on any hit.

## 7. [minor] What `context_expand` returns for container sections is unspecified

§4 rule 4 omits deep sections from the prompt and says they're "still expandable by ID via search
results or the skeleton's named ancestors" — but expanding an ancestor is only useful if the
result *lists its children's IDs/names*, and §6 never says an expand result includes child
structure. Also, `full` on a chapter/part could be tens of thousands of tokens; the 0.9×hardCap
refusal handles the budget but the error suggests only `long` or search — with no way to enumerate
children, the model can dead-end. **Fix:** specify that expanding a non-leaf section returns its
summary at the requested level *plus* a one-line-per-child index (`id`, `name`, token count),
giving the model a navigation path downward.

## 8. [minor] Replace-in-place re-elevation breaks the `elevatedAtTask` ordering invariant

§2.2 declares `elevated` is "append-ordered by elevatedAtTask" and that re-elevation replaces "in
place (same position)." If `elevatedAtTask` is updated on re-elevation, the array is no longer
sorted by it and the §8.2 eviction tie-break ("lower elevatedAtTask evicted first") changes
meaning; if it isn't updated, the field name lies. Implementer must guess. **Fix:** keep
`elevatedAtTask` immutable (it records slot position), and rely on `lastCitedTask` for recency;
say so explicitly. Also note that "everything after it is preserved" in §2.2 preserves *bytes*,
not cache — a mid-region byte change still invalidates the prefix from that slot (§5.4's table
gets this right; §2.2's phrasing will mislead).

## 9. [minor] Elevated items have no staleness check when the user edits their source

Anchors get a content-hash check (§11); elevated ledger items don't. A user can edit a world-info
entry or a summary that is currently elevated: the stored `tokens` estimate goes stale (budget
math drifts) and — since re-rendering happens at assembly — the `<expanded-context>` bytes change
without a `cache_break` event being attributable. A1 already promises "a change event or content
hash" from the data model. **Fix:** re-estimate `tokens` (via the §8.3 content-hash cache, already
built) for any elevated item whose source hash changed, at `beginTask`.

## 10. [minor] Dangling reference and underspecified edit-task window

§4 rule 1 cites "(§10.2)" for edit-task re-centering; no §10.2 exists. The actual behavior —
how many tokens before/after the target, whether rules 2–4 recompute relative to the target or
stay frontier-relative (big cache implications: an edit task mid-book that recenters the skeleton
would invalidate `<global-context>` for one task and back), what "far from frontier" means in §9 —
is never pinned down. **Fix:** write the missing subsection: window = target ± N tokens (give N);
skeleton stays frontier-relative (elevations via `target` source carry the local surroundings);
define "far" as target outside the frontier window.

## 11. [minor] Anchor scoring is more machinery than the brief needs — trim it

The brief asks for "a range of pieces from different moods throughout the work" and grants "broad
discretion." Positional stratification (one excerpt per quartile, scene openings, paragraph-cut)
already satisfies that. The extra scoring — `moodTag` (a new cross-subsystem obligation on
enrichment) plus `dialogueRatio` (another enrichment-time computed field, plus a comparison rule
with a magic 0.25 threshold) — is exactly the kind of fiddly heuristic the brief strips, and the
proposal itself admits the fallback "alone satisfies" the requirement. **Fix:** MVP = pure
stratification + tie-breaks; move both moodTag *and* dialogueRatio scoring to the deferred list
(moodTag already is; dialogueRatio should join it). This also shrinks interface assumption A2.

## 12. [minor] `estimateAssembledTokens(state)` at finalize can't know the next task's shape

§7.2 computes overage from "next task's prompt, estimated," but the next task's type is unknown
(quick edit shrinks the frontier to 3k; edit tasks swap the window entirely), and the situation/
task regions are unknowable. Different assumptions give different decay steps. **Fix:** one
sentence: estimate assumes a plain `continue` task with the current situation pane; that's the
dominant case and only the overage bucket (not exactness) matters.

---

## What was checked and found sound (no padding — one line each, for the record)

- Progressive soft penalty + hard cap matches the brief's "kicks in well before the actual total
  context size … exceeding … should be allowed, but accelerate dropping of older items."
- 6k tail + 4k pinned anchors satisfies "10k tokens … isn't just the latest writing."
- `<local-context-refresh>` append is a genuinely good, cache-perfect answer to the brief's
  reasoning-model voice-collapse concern.
- No vector RAG anywhere; literal search fits "grabbing precise info."
- Derived-cache `state.json` with regenerate-on-corruption honors "files are the truth."
- MVP cut list is honest; deferred items genuinely have no live code paths.

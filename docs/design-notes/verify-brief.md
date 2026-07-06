# Brief-Compliance Verification — Final Doc Set

Verifier pass over the founder's verbatim brief (`scratchpad/brief.md`) against
`docs/00-overview.md`, `02-data-model.md`, `03-api.md`, `04-frontend.md`, `05-agents.md`,
`06-context-engine.md`, `07-prompting.md`, `08-illustration.md`, `09-testing.md`.
Date: 2026-07-06.

Legend: **[missing]** brief requirement not covered · **[contradiction]** doc conflicts with the
brief · **[overreach]** complexity the brief explicitly strips. Severity prefix per finding:
blocker / major / minor. Areas with no finding get a one-line compliance note.

---

## Verdict up front

**Compliant, with 7 minor findings and no blockers or majors.** Every load-bearing brief
requirement is covered, none is contradicted in substance, and the doc set does not smuggle in
the stripped complexity classes (no fiddly UI knobs — all tunables are config-file only per
00 §Principles and 04 §11; no RAG/vector search — 06 explicitly substitutes literal text search;
no tag-style image prompting or negative prompts — 08 §4.2 rule 3 bans them; no key-gated world
info for prose prompts — 02 §2.6 / 06 §4.1 rule 6; no enterprise ceremony — 03 §13 "explicit
non-goals honored": no auth, tenancy, rate limiting, CORS, helmet).

---

## Findings

### F1 · [missing] · minor — Hovercard fallback when an entry has no summary
**Brief:** "Hovering on them should show a small version of the entry (its summary and image if
present; **if no summary, the first few lines of the text**)."
**Doc:** 04 §6.3 specifies the hovercard as "entry name, `shortSummary`, 48 px thumbnail if the
entry has an image, and 'open ↗'" — the no-summary → first-few-lines-of-body fallback is never
stated. `shortSummary` is nullable (02 §10.6), so a summary-less entry would render an empty
card. The data is already at hand (`GET /world` returns full bodies, 03 §3.5).
**Fix:** one sentence in 04 §6.3: when `shortSummary` is null, show the first ~3 lines of the
rendered body instead.

### F2 · [contradiction] · minor — Only the first key match per entry per block is highlighted
**Brief:** "if they are [given] **any matches** in the main text should be *subtly* indicated."
**Doc:** 04 §6.3: "Only the **first match per entry per block** is decorated (repeated highlights
of 'Mara' forty times per scene is noise)."
**Assessment:** a deliberate, defensible UX call, but it is a literal deviation from "any
matches" and the doc doesn't acknowledge the brief when making it. Blocks are snippet/section
sized, so most matches in view are still indicated; the miss is repeats within one block.
**Fix:** either decorate all matches with the existing whisper-quiet style (dotted underline is
subtle enough to tolerate repetition), or keep first-per-block and add an explicit "deviation
from the brief's 'any matches', chosen because …" note so the decision is on the record.

### F3 · [contradiction] · minor — Keys gate world-info inclusion for *low-lane* prompts
**Brief:** "We **do not** use keys for choosing what context to send to the model at present."
**Doc:** the context engine honors this fully for all interactive/prose prompts (every entry
included at `short`, 06 §4.1 rule 6). But `matchWorldEntries` (a key scan) selects which world
entries enter the **illustration composer brief** (08 §4.2, cap 4 entries) and the
**enrich-section prompt** (05 §4.4, cap 8 entries) — key-gated selection of context sent to the
low model.
**Assessment:** confined to background/low-lane tasks where "send everything" would bloat cheap
calls for no benefit, and 02 §2.6 does name the illustration pipeline as a key consumer — but no
doc acknowledges that this is a scoped exception to the brief's rule.
**Fix:** one sentence in 08 §4.2 (and/or 06's key-decisions list): "the brief's 'keys never
choose model context' rule applies to the prose/context engine; background low-lane briefs use
key matching as a relevance cap, a deliberate scoped exception."

### F4 · [missing] · minor — Editor presents no visible Save control
**Brief:** "Double-clicking into these makes them editable … **presenting cancel / save** to go
back to the display mode."
**Doc:** 04 §7.1 specifies Enter = newline, **Ctrl-Enter = save**, and "**Esc** or the ✕ cancel
button = cancel" — a visible cancel affordance exists, but save is keyboard-only. The brief asks
for both buttons to be presented.
**Fix:** add a Save button (with the ⌃⏎ hint) beside the ✕ in the editor chrome; behavior
otherwise unchanged.

### F5 · [missing] · minor — Multi-level section schemes deferred beyond M2
**Brief:** sections are "Nested … there may be several different, nestable levels within it,
e.g., book, part, arc, chapter, scene … it should be **easy to change them on the back-end**.
Let's assume these are *always* nested."
**Doc:** the tree machinery, schemas, `levelScheme`, depth-aware rendering, and interior-section
rules are fully general everywhere (02 §2.1/§2.3, 04 §5.2, 06 §4.1), but the shipped default is
flat `["chapter"]` and "multi-level schemes enabled per work" is *structured-for, deferred beyond
M2* (02 §13); 02 §2.1 also calls a scheme change "a controlled data migration."
**Assessment:** the inclusion-relation-is-a-tree requirement is satisfied (a flat chapter list is
a tree), and generality is designed in — but "easy to change on the back-end" lands somewhat
weaker than the brief's tone.
**Fix:** none required for correctness; consider pulling "enable `["part","chapter"]` per work"
into M2 (the docs claim it is a directory reshuffle + index rebuild, i.e. already cheap), or note
in 02 why it slipped past M2.

### F6 · [contradiction] · minor — Image-gen latency assumption widened from "< 20 s" to 10–90 s
**Brief:** "We can assume the image gen itself is cheap, taking **< 20 seconds** per image."
**Doc:** 08 (preamble) assumes **10–90 s** and says so explicitly: "Latency is stated as an
explicit assumption of this design, not a product requirement."
**Assessment:** self-flagged, and the design is strictly more robust under the wider assumption
(budget gate degrades to fewer attempts). Recording it here because it is a literal divergence
from a stated brief assumption.
**Fix:** none needed; the in-doc flag satisfies "flag it loudly rather than silently deviating."

### F7 · [contradiction] · minor — Workflow contract requires `%seed%` (and `%prompt%`) markers
**Brief:** "A given workflow is assumed to **take a prompt and return an image**."
**Doc:** 08 §2.2 additionally requires the user to mark **at least one `%seed%` node** (and
recommends `%output%`); an unmarked workflow fails registry validation.
**Assessment:** well-justified (without seed injection every retry renders the identical image
and ComfyUI's cache short-circuits the loop — the agentic-feedback mechanism the brief *does*
demand would be inert), validation errors are actionable, and marking is a one-time GUI rename.
Still a real extension of the brief's workflow contract that the user must perform.
**Fix:** none needed beyond docs/README making the two-marker requirement prominent in setup
instructions; 08 already explains the why.

### F8 · observation (no severity) — Edit-task pane and its token meter ship in M2
**Brief:** enumerates the edit-task detailed pane (instructions, section/world-info selection,
token estimate) and the quick box's "opportunity to expand to a detailed pane."
**Doc:** the pane is specified in full (04 §9.2 — "so M2 is a wiring exercise"), its API
(`edit-task` spec, `/context/candidates`, `/context/preview`, `/tasks/estimate`) is designed,
and `/context/preview` itself ships M1 — but the pane and the quick-box→pane expansion land in
M2. The brief sets no milestones, so this is a sequencing choice, not non-compliance; recorded
so the cut is a conscious one.

---

## Area-by-area compliance (no findings beyond the above)

**Frontier / snippet / section semantics & consolidation** — Compliant. Frontier defined as the
term of art (00 glossary); snippets carry authorship + full revision history with cycle/rollback
(02 §2.4, 04 §7.3); automatic snippet→section transition via debounced, heuristics-gated,
agent-decided consolidation with undo (02 §6); precise history is collapsed at consolidation
while provenance run-ids survive — exactly the brief's "lean toward collapsing, but editing back
there merely works" (02 §6.4–6.5); edits behind the frontier "merely work" with derived
staleness.

**Enrichment fields & summary substitutability** — Compliant. Short/long summaries, one
illustration, optional name — all optional, all user-editable, user edits pinned against agent
clobbering (02 §2.5, 03 §3.2, 04 §4.2); the substitutability principle is stated as the design
rule (00 glossary), applied in reverse for un-enriched sections (06 §4.1 rule 2), enforced in
template wording ("`<summary-short>` must contain nothing that is absent from `<summary-long>`";
"never state anything the chapter plus earlier summaries does not establish" — 07 §6.5), and
spot-checked in the manual eval loop (09 §10).

**One image per section** — Compliant. Hard invariant in 02 §2.5 (`0..1 Illustration`,
three-state slot with a never-resurrect tombstone), 08 §6 ("exactly one illustration per section
is a data-model invariant"; losing candidates discarded in M1); more images = deeper sectioning,
which the general tree supports.

**Low/high model split; high model never sees images** — Compliant. Kind-routed lanes (05 §2–3);
high = writing + heavyweight agentic, low = summaries/boundaries/image loop; **type-enforced**
no-image rule on the high client (05 §3.1), restated at every consumer (00 glossary, 08 §4.3:
"the only place in Cowrite where a model receives an image, permitted only on the low lane");
low-model VLM critique with downscaled images. Same-model-for-both is trivially supported
(two endpoint configs may point at one server).

**ComfyUI assumptions** — Compliant (see F6/F7). Prompt-in/image-out workflows, all fiddly bits
(samplers, LoRAs, negative prompts, resolution) live in the user's workflow file (08 §1);
multiple workflow types/quality levels: registry + `route` built, one `default` shipped, picker
deferred — exactly the brief's "build room for it"; quality via agentic feedback (compose →
generate → VLM critique → revise, bounded, best-of), not workflow complexity; natural-language
descriptive prompts only — tag lists, negative phrasing, quality boilerplate, artist names all
banned in the composer contract (08 §4.2 rule 3, 07 §8).

**Storage human-readability** — Compliant. Markdown + YAML frontmatter + JSONL + JSON + PNG,
grouped per work, git-diffable, duplication accepted (with honest run-file size numbers, 05
§7.2); SQLite strictly a rebuildable cache; external edits reconciled, never fought, no user
file ever deleted (02 §5, §7, §8).

**Console app, Windows + Linux** — Compliant. `pnpm install && pnpm build && pnpm start`,
SillyTavern-style; localhost bind, no auth/tenancy; browser auto-open; first-class Windows parity
table (paths, atomic writes, signals, teardown ordering, shell-free scripts) and Windows CI for
unit/integration (03 §10, 09 §6.1). The Host-header allowlist (03 §5.4) is 10 lines of
DNS-rebinding defense, not enterprise ceremony — appropriate for an unauthenticated localhost API.

**UI element enumeration** — Compliant except F1/F2/F4/F8. Verified individually: double-click
edit with Enter=newline / Ctrl-Enter=save / cancel (04 §7.1, §12; brief's "opening for editing
removes selection" quoted and honored); single-click select with provenance widgets, revision
cycler, and per-version prompt/process via the run-timeline provenance viewer (04 §7.2–7.4);
quick-edit box on selection (04 §7.2); progressive collapse in the brief's exact order —
full-text sections → long summaries → short summaries → name+illustration cards (04 §5.1, §5.3);
subtle dialogue tint on rendered text with provenance coloring taking over on selection (04
§6.2, §6.4); illustration right-of-text at `full`, inline card at `name` (04 §10); frontier bar
＋snippet / Continue (Ctrl-Enter when nothing selected) / Instruct… with instruction styling that
never looks like prose (04 §8.1–8.2, §12); situation pane left, optional, own scroll, one-click
copy-from-selection (04 §9.1); edit-task pane with candidate pickers and a server-computed token
meter explicitly rendered with "~" — "doesn't have to be exact" honored (04 §9.2, 06 §8.3);
world-info key highlighting with hovercards and click-through to the world panel entry (04 §6.3,
§9.3).

**World-info / context entries** — Compliant (see F3). Name, optional keys (zero keys valid
everywhere), markdown body rendered when not edited and placed directly in prompts, image
(user-facing only for now, generate or upload, future illustration use structured-for — 08 §7),
single short summary only (02 §2.6, §10.6; 04 §9.3).

**Prompting structure** — Compliant. Markup-blended-with-markdown line-anchored tag grammar with
no escaping (07 §1–3), matching the brief's example shape; instructions at top, freshest prose at
bottom, `<local-context-refresh>` closing the composition gap after tool use (06 §5.3, 07 §5.2);
cache-friendliness is a first-class design axis (stability ordering, append-only loops,
byte-identical `tools` array, golden-prefix tests — 05 §4.1, 06 §5, 09 §3.3); ~10k tokens of
ranged prose = ~4k stratified voice anchors + 4–12k frontier full text, deliberately "not just
the latest writing" (06 §4.3, 07 §5.2); instruction/prose delineation is structural (prose only
inside `<snippet>`/`<excerpt>`/`fidelity="full"`; user words always in
`<user-instructions>`/`<situation>`, framed as directives never to be transcribed — 07 §5.2–5.3),
mirrored visually in the UI (04 §8.2).

**Smart context management** — Compliant. Hierarchical summaries to the top level with a total
coverage invariant (06 §4); planning tool-calls to expand/search or just start writing, with
prose-with-no-tools *being* the composition (06 §6, 05 §4.1); citation assessment at task end
with TTL = 3 "several actions" decay (06 §7); soft budget (32k) that may be exceeded and whose
overage accelerates decay 1→3 steps, hard cap enforced by legible keep-score eviction, kicking in
well before the model window (06 §7.2, §8.1–8.2); profiling designed in (`usage.jsonl`,
`cache_break` events, `promptsHash`, M1.5 eval loop — 06 §8.4, 07 §9, 09 §10). No RAG, no
vectors; literal search covers the brief's "grabbing precise info" case (06 §6).

**Fixed baseline stack** — Compliant. TypeScript everywhere, pnpm monorepo with
`apps/server` (Node 22+, Fastify 5) / `apps/web` (Vite + React 19) / `packages/shared` (Zod);
files-as-truth + rebuildable SQLite; REST + SSE, no auth, localhost default; Vitest + Playwright
+ mock OpenAI/ComfyUI servers; single console start; hobby-app simplicity with professional
standards (00 §Stack, 03, 09).

---

## Summary table

| # | Type | Sev | One-liner | Where |
|---|---|---|---|---|
| F1 | missing | minor | Hovercard lacks the no-summary → first-lines-of-body fallback | 04 §6.3 |
| F2 | contradiction | minor | First-match-per-block highlighting vs brief's "any matches" | 04 §6.3 |
| F3 | contradiction | minor | Keys gate world-info in illustration/enrich low-lane prompts, unacknowledged as a brief exception | 08 §4.2, 05 §4.4 |
| F4 | missing | minor | Editor shows a cancel button but no visible Save control | 04 §7.1 |
| F5 | missing | minor | Multi-level section schemes deferred beyond M2 vs "easy backend change" | 02 §2.1, §13 |
| F6 | contradiction | minor | 10–90 s image-gen assumption vs brief's "< 20 s" (self-flagged in-doc) | 08 preamble |
| F7 | contradiction | minor | Workflow must carry `%seed%`/`%prompt%` markers beyond "takes a prompt" | 08 §2.2 |
| F8 | observation | — | Edit-task pane (+ meter, quick-box expansion) is M2 by internal sequencing | 04 §9.2 |

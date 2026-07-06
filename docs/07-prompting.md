# 07 — Prompting: Markup Format, Templates, Voice Rules

Scope: the canonical prompt format for every model call Cowrite makes. This doc owns the tag
grammar (region tags, item tags, marker tags, output-block tags), attribute conventions, nesting
and collision rules, the canonical region-name strings, the wording of every prompt template
(`prompts/*.md`), the voice-preservation rules, and the rules for delineating instructions from
manuscript prose. Region *ordering* and assembly mechanics are owned by 06-context-engine.md;
which output blocks each task kind expects, and how they commit, by 05-agents.md; the
image-generation loop by 08-illustration.md. Those docs reference the grammar here rather than
redefining it.

## Key decisions

- **Line-anchored tag markup blended with Markdown** — a small, closed vocabulary of XML-ish
  tags gives the prompt structure and machine-parseable output; everything inside a tag is plain
  Markdown. Tags are recognized only at the start of a line, so the format needs **no escaping,
  ever**: manuscript prose passes through byte-for-byte.
- **One grammar everywhere** — the same tags serve context regions, in-place edit markers, tool
  results, and the model's output blocks. One renderer, one parser, one thing to learn.
- **Manuscript prose is machine-distinguishable from everything else** — real prose appears
  *only* inside `<snippet>`, `<excerpt>`, `fidelity="full"` blocks, and `<target>` spans; every
  summary carries its fidelity attribute; instructions and world-info are never confusable with
  story text. This is the voice-preservation delineation rule, made structural.
- **User words are never story text** — instructed-continue text, quick-edit instructions, and
  the situation pane always travel inside `<user-instructions>` or `<situation>`, framed as
  directives the model follows but never quotes.
- **Voice by exhibit, not description** — templates point the model at the anchor excerpts and
  local context and forbid style adjectives; describing a voice in instructions gives reasoning
  models an attractor to collapse into.
- **Stable top, churn at the bottom** — the system prompt is byte-identical for every
  interactive task in a work; per-kind wording lives in `<instructions>`; the plain-`continue`
  `<task>` region is a byte-constant, so back-to-back continues differ only in the growing
  `<local-context>`.
- **Whole-target rewrite output in tag blocks** — opening/closing tags alone on their own lines,
  greedy line-anchored close, ids echoed verbatim; never search/replace, never JSON prose.
- **Templates are files, versioned by hash** — `prompts/*.md` with `{{slot}}` substitution,
  hot-reloaded in dev, content-hashed into every run's `meta.params`, and all marked **v0**:
  the wording below ships, then gets rewritten against `usage.jsonl` profiles.

---

## 1. The format: markup blended with Markdown

Every prompt Cowrite renders — interactive tasks, background enrichment, illustration
composition — is a sequence of **regions** delimited by tags, in the order fixed by
06 §assembly. Inside a region, content is Markdown (headings, lists, emphasis all legal); the
tags exist to tell the model *what kind of thing it is reading* and to tell our parsers where
blocks begin and end.

This is deliberately not XML. There is no document tree, no entity escaping, no self-closing
syntax rules beyond our own, and no XML parser anywhere in the system. It is a line-oriented
convention:

1. **Structural tags start at column 0 on their own line.** An opening tag, a closing tag, or a
   self-closing tag is a whole line. The only exceptions are the two inline markers
   (`<selection>` and `<p n/>`, §2.4), which appear only inside edit targets.
2. **The vocabulary is closed.** The tables in §2 are exhaustive. The renderer emits nothing
   else; the output parser recognizes nothing else; anything tag-shaped that isn't in the
   vocabulary is ordinary text.
3. **Content is never escaped or transformed.** Prose goes into the prompt byte-for-byte — a
   requirement of both voice preservation (the model must see the real text) and cache
   stability (re-rendering must be byte-deterministic).
4. **Attribute values are sanitized; content is not.** Attributes hold ids, numbers, fidelity
   levels, and human-readable names. Names (section titles, entry names, excerpt sources) get a
   display transform before quoting: `"` → `'`, newlines → single space, truncated to 120
   chars. The underlying stored data is untouched.

### 1.1 Message shape

- The **system message** is the per-work system prompt (§6.1) — identical bytes for every
  interactive task in a work.
- The **first user message** carries all regions, in 06's canonical order, concatenated with one
  blank line between regions.
- **Planning turns append** the standard OpenAI way: an assistant message with `tool_calls`,
  then one `tool` message per call. Tool results reuse the item grammar (§2.2) — an expanded
  section arrives as the same `<section …>` block it would occupy in `<expanded-context>`,
  followed by the engine's one-line budget status. Expanded material therefore reads
  identically wherever the model meets it.
- The **refresh turn** (when tools were used) is one more user message: a
  `<local-context-refresh>` region plus the composition cue (§6.7).
- Nothing earlier in the conversation is ever rewritten (05 §loop).

---

## 2. Tag vocabulary

### 2.1 Region tags (top level of a user message)

| Tag | Contents | Appears in |
|---|---|---|
| `<instructions>` | per-task-kind rules and output contract; Markdown | all prompts |
| `<world-info>` | `<entry>` items, entry-creation order | interactive, enrich, illustrate |
| `<global-context>` | `<section>` items, flat, document order, default fidelities | interactive, enrich, boundaries |
| `<voice-anchors>` | `<excerpt>` items (06 §anchors) | interactive |
| `<expanded-context>` | `<section>` / `<entry>` items, ledger append order | interactive |
| `<situation>` | the situation pane, verbatim Markdown | interactive, when non-empty |
| `<task>` | this task's directive; may contain `<user-instructions>`, `<selection-excerpt>`, `<edit-target/>` refs | interactive |
| `<local-context>` | `<snippet>` items — all un-consolidated snippets, full prose | interactive, boundaries |
| `<target>` | the material being worked on when it is not in `<local-context>`: a frozen-section edit window (M2, §2.4) or, for background kinds, the section under enrichment / the illustration subject | edit-task (M2), enrich, illustrate |
| `<local-context-refresh>` | verbatim tail of `<local-context>` (06 §refresh) | refresh turn only |
| `<established-imagery>` | `<imagery>` items — prior winning image prompts (08 §compose) | illustrate |
| `<guidance>` | user's regeneration guidance, verbatim | illustrate, when present |

Every region appears at most once per message. Empty regions are omitted entirely (no
`<situation></situation>` husks — an empty region is a byte-churn liability and reads as noise).

The **canonical region-name strings** — used in `ContextSnapshot.regions`, `usage.jsonl`
per-region counts, and the provenance viewer (04 §provenance) — are the tag names without
brackets: `instructions`, `world-info`, `global-context`, `voice-anchors`, `expanded-context`,
`situation`, `task`, `local-context`, `target`.

### 2.2 Item tags (one level inside a region)

| Tag | Attributes | Notes |
|---|---|---|
| `<section>` | `id` (ULID), `name`, `fidelity` (`name\|short\|long\|full`), `level` (e.g. `chapter`), `path` (ancestor names joined by ` › `; present in `<expanded-context>` and on deep skeleton entries) | at `fidelity="name"` it is a self-closing one-liner: `<section id="…" level="chapter" name="…"/>`; at other fidelities a block whose content is the summary — or, at `full`, the section's `content.md` verbatim |
| `<entry>` | `id`, `name`, `fidelity` (`name\|short\|full`) | world-info entry; content is its one-line summary (`short`) or full Markdown body (`full`); `name` fidelity is self-closing |
| `<excerpt>` | `from` (source section name), `tokens` | voice anchor; content is manuscript prose verbatim |
| `<snippet>` | `id` (ULID, or `new` in output); optional `role="edit-target"` | frontier prose verbatim; in prompts the id lets the model target it, in output it names what the block replaces |
| `<imagery>` | `from` (section or entry name) | one prior winning image prompt (illustrate compose only) |

Fidelity attributes are load-bearing for the model: the system prompt defines
`fidelity="full"` as *manuscript text* and everything lower as *summaries about the
manuscript* (§5.2). Token counts appear only on `<excerpt>` (stable between anchor refreshes);
they are deliberately absent from sections and entries, where they would churn bytes whenever
the estimator or content shifted.

### 2.3 `<task>` internals

`<task>` carries a `kind` attribute and a short directive. User-supplied material inside it is
always wrapped:

| Tag | Contents |
|---|---|
| `<user-instructions>` | the user's instructed-continue text, quick-edit instruction, or edit-task brief — verbatim, unescaped |
| `<selection-excerpt>` | the user's selected story text, verbatim (quick-edit / edit-task); a quotation acting as a pointer, never a style exhibit |
| `<edit-target/>` | self-closing reference to a target whose text lives elsewhere: `<edit-target kind="snippet" id="…"/>` or `<edit-target kind="section-span" section="…" from="…" to="…"/>` (M2) |

### 2.4 Marker tags (inside `<local-context>` / `<target>` only)

| Tag | Use |
|---|---|
| `role="edit-target"` on `<snippet>` | marks the quick-edit target snippet in place (06 §quick-edit) |
| `<selection>…</selection>` | the only inline tag pair: brackets the user's selected characters inside the target |
| `<p n="12"/>` | paragraph marker line preceding each paragraph of a frozen-section span (M2); output must not contain them |
| `<before>` / `<span>` / `<after>` | inside `<target>` (M2): `targetWindowTokens` of surrounding prose, then the editable span (`<span from="…" to="…">` — character offsets matching the spec), then the trailing window. Only `<span>` content may be rewritten |

### 2.5 Output-block tags (model → harness)

The complete set; 05 §output-contract owns which blocks each kind expects and how they commit.

| Block | Emitted by | Content |
|---|---|---|
| `<snippet id="new">` | continue, instructed-continue | the new snippet's full prose |
| `<snippet id="<ulid>">` | quick-edit, edit-task | the complete rewritten snippet |
| `<span section="…" from="…" to="…">` | quick-edit / edit-task on frozen spans (M2) | the complete rewritten span, no `<p/>` markers |
| `<title>` | enrich-section | section title, ≤ 8 words |
| `<summary-short>` / `<summary-long>` | enrich-section | the two summary levels |
| `<boundaries>` | propose-boundaries | one JSON object (`BoundaryProposal`, 02 §boundaries) |
| `<image-prompt>` | illustration composer/reviser | one descriptive paragraph, 60–120 words (§8) |

Format rules the templates state to the model (and `TagBlockParser` enforces, 05 §parser):

- each opening and closing tag alone on its own line;
- block content is Markdown prose (or bare JSON, for `<boundaries>`) — never nested tags, never
  code fences around the block;
- ids and span offsets echoed **verbatim** from the prompt;
- emit exactly the expected blocks; text outside them is tolerated and discarded ("Here's the
  revised passage:" preambles cost nothing), unknown ids are dropped with a warning, a missing
  mandatory block triggers the repair turn (§6.8).

---

## 3. Nesting, collisions, and the no-escaping rule

### 3.1 Nesting

Maximum structural depth is two: regions contain items, items contain Markdown. The exceptions
are confined to edit targets: `<target>` contains `<before>/<span>/<after>` at depth two, with
the inline markers (`<selection>`, `<p n/>`) inside prose at depth three. Items never contain
other items; regions never repeat.

### 3.2 What happens when story text contains tag-like strings

Nothing — by design. The rules that make no-escaping safe:

- **Input side.** The renderer never scans prose for tags and never alters it. A story about
  the web can contain `<div>` on its own line; a character can literally say
  "`</world-info>`". None of it is in a position the renderer created, and the model has been
  told (system prompt, §6.1) that only the closed vocabulary is structural. The residual risk —
  prose containing, at column 0 on its own line, a byte-exact copy of one of our closing region
  tags — could momentarily confuse the model about where a region ends. This is accepted:
  vanishingly rare in fiction, worst case is model confusion (not data corruption, since input
  regions are never re-parsed by us), and the alternative — entity-escaping prose — would
  corrupt the voice exhibits and break byte-stability guarantees for the cache.
- **Output side (where parsing is real).** `TagBlockParser` (05 §parser) recognizes only the
  expected block set for the task; an opening tag counts only at line start; a closing tag
  counts only when alone on a line; and a block closes **greedily at the last matching
  line-anchored close tag** before the next expected opening tag or end of output. So a
  rewritten snippet whose prose contains `</snippet>` mid-line never terminates the block, and
  even a line-alone stray close is survived unless it is genuinely final. Property tests feed
  the parser adversarial prose containing every tag in the vocabulary at every position
  (09 §parser tests).
- **Attributes.** The only place content can break syntax is inside a quoted attribute, which
  is why names are sanitized (§1 rule 4) and prose never appears in attributes.

---

## 4. Worked example: a mid-novel `continue`

The full first user message for a plain continue on a work with two frozen chapters, elided
(`⋮`) only inside long prose. The system message is §6.1 verbatim.

```not-xml
<instructions>
## This task: continue

Continue the manuscript past the end of <local-context> with roughly one page of new prose
(300–700 words). Move the scene forward; end at a natural beat, not mid-sentence. Do not
summarize, do not skip ahead in time unless the prose demands it, and do not repeat or rephrase
text that is already written.

When you are ready, output exactly one block and nothing else:

<snippet id="new">
…your new prose…
</snippet>
</instructions>

<world-info>
<entry id="01J2N8Q3F7VWXK2MR9T5BCAD01" name="Mara Voss" fidelity="short">
Keeper of the Saltmarsh light; late forties, cropped grey hair, a ruined left hand she hides in
a fingerless glove. Widowed by the same storm the town pretends was weather.
</entry>
<entry id="01J2N9AAE2QRSTK4MP7Y3XCD02" name="The storm glass" fidelity="full">
A sealed spirit-glass from the old lighthouse inventory. Its crystals bloom hours before
weather arrives — and, Mara now suspects, before other things arrive too.

**Appearance:** a hand-blown teardrop of cloudy glass on a brass gimbal, whale-oil sheen.
</entry>
</world-info>

<global-context>
<section id="01HZQA55M2C8DWPN6R3VTEXA10" level="chapter" name="The Lighthouse Keeper" fidelity="short">
Mara Voss takes over the decommissioned Saltmarsh light after her predecessor drowns. She finds
the lamp room sealed from the inside and an inventory listing one item too many.
</section>
<section id="01J2KF8T4YB1HZQX7WN2SDEA11" level="chapter" name="The Storm Glass" fidelity="long">
Mara retrieves the storm glass from the sealed lamp room. Over three nights its crystals bloom
in dead calm; each bloom precedes a boat failing to return. She logs the pattern, tells no one.
⋮ The chapter closes with Edlen, the harbormaster, demanding the inventory book "for the
insurers" and Mara handing him a copy with the glass's line inked out.
</section>
</global-context>

<voice-anchors>
<excerpt from="The Lighthouse Keeper" tokens="1010">
The light had been dark for eleven years, and the town had learned to say so the way you say a
grace — quickly, and without looking up. Mara carried her cases up the spiral stair one at a
time, resting on the landings, counting the gulls through the salt-fogged panes.
⋮
</excerpt>
<excerpt from="The Storm Glass" tokens="980">
Third night. No wind, the marsh flat as poured lead, and the crystals climbing anyway —
feathering up the glass like frost in a hurry.
⋮
</excerpt>
</voice-anchors>

<expanded-context>
<section id="01J2KF8T4YB1HZQX7WN2SDEA11" path="The Storm Glass" fidelity="full">
The lamp room key turned as if it had been oiled that morning.
⋮ (full chapter text — opened by the model two tasks ago; still within TTL)
</section>
</expanded-context>

<situation>
Scene: Mara confronts Edlen in the harbor office, dusk, storm building. She wants the original
inventory back. He knows more than he says. Don't resolve it yet — end with her outside in the
first rain.
</situation>

<task kind="continue">
Continue the story directly from the end of <local-context>.
</task>

<local-context>
<snippet id="01J2P7R9GT5W0ZNXK3M8QAB4CD">
The harbor office kept its lamps lit all day in October, which told you what the windows were
worth. Mara came in with the copy of the inventory under her arm and the original's absence
like a stone in her boot.
</snippet>
<snippet id="01J2P7SVWX2Y1ANBK9M4QCD5EF">
Edlen did not stand. "Keeper," he said, and made the word sound like a job he'd once turned
down.
⋮
</snippet>
</local-context>
```

The model may answer with prose immediately (that prose *is* the composition — 05 §loop), or
call `context_expand` / `context_search` first, in which case the refresh turn (§6.7) precedes
composition. A well-formed answer:

```not-xml
<snippet id="new">
"The insurers," Mara said, "have never once asked for a book they could read."
⋮
</snippet>
```

---

## 5. Region ordering, cache-friendliness, and voice preservation

### 5.1 Ordering and byte-stability (recap; 06 owns the mechanics)

Regions are ordered by decreasing stability — 06 §assembly is normative. What a prompt author
needs to know:

| Stable | Region | Byte-stable across… |
|---|---|---|
| most | system message | every task in the work (changes on app upgrade / template edit) |
| | `instructions` | every task of the same kind |
| | `world-info` | until the user edits an entry |
| | `global-context` | between consolidation/enrichment events and summary/title edits |
| | `voice-anchors` | between anchor refreshes (~once per chapter) |
| | `expanded-context` | append-only per elevation; slot-rewrite on decay/re-elevation |
| | `situation` | until the user edits the pane |
| | `task` | byte-constant for plain `continue`; per-task otherwise |
| least | `local-context` (+ `target`) | never — the frontier grows every task; churn belongs here |

Consequences for wording, owned here:

- **The plain-`continue` `<task>` region is a fixed string** ("Continue the story directly from
  the end of `<local-context>`."). Back-to-back continues — the dominant rhythm — therefore
  reuse the entire prefix through `<situation>` and differ only from `<task>`'s final bytes
  onward.
- **Per-kind wording lives in `<instructions>`** (region 1), so switching task kinds is a
  full-prefix miss. Accepted for v0: kind switches are far rarer than kind repeats, and the
  alternative (folding all kinds' rules into one region) bloats every prompt. If profiling
  shows kind-switch misses dominate (§9), the per-kind clause moves into `<task>` and
  `<instructions>` becomes kind-invariant — a template edit, no code change.
- **Templates never interpolate volatile values into stable regions** — no timestamps, no
  token totals, no "task 41 of this session" anywhere above `<task>`.
- **Tool-call turns are pure appends** (§1.1); the `tools` array is byte-identical on every
  request of a run, and the composition call differs only by `tool_choice: "none"` — a
  decoding-side flag that changes no prompt bytes (05 §loop).

### 5.2 Voice preservation

The brief's two requirements, and how the format meets them:

**Enough real prose, from a range of moods.** Every interactive prompt carries ~10k+ tokens of
manuscript text: `voice-anchors` contributes ~4,000 tokens of excerpts positionally stratified
across the whole work (06 §anchors — early, middle, late; different moods by construction), and
`local-context` contributes the full un-consolidated frontier (typically 4–12k tokens). Neither
is optional, and neither is ever summarized.

**Extreme delineation, frontier prose at the bottom.** Delineation is structural, not rhetorical:

1. Manuscript prose appears **only** inside `<snippet>`, `<excerpt>`, `fidelity="full"` blocks,
   and `<target>` windows. The system prompt states this as a reading rule, so "what am I
   writing to?" is answerable from tags alone.
2. Everything at `fidelity="name" | "short" | "long"` is a summary *about* the manuscript, in a
   deliberately plain register, and is labeled as such.
3. `<local-context>` is the last region of the assembled prompt; during composition after tool
   use, the refresh turn (§6.7) re-places the final ~1,000 tokens of it immediately above the
   generation point, closing the gap that planning chatter opened. This is the mitigation for
   reasoning models' tendency to collapse voice after long thinking traces: the pretraining
   gradient — continue the text nearest the bottom — is pointed at real prose, not at tool
   transcripts or instructions.

**Instruction phrasing rules** (all templates comply; these keep reasoning models from
collapsing the voice):

- **Point at exhibits, never describe.** "Match the prose in `<voice-anchors>` and
  `<local-context>`" — never "write in a lyrical, melancholy style". Adjective lists become
  attractors: the model writes to the description instead of the text.
- **Keep the instructions register flat and terse.** Instructions written with flourish leak
  flourish.
- **The composition cue is a continuation cue, not a fresh-task cue.** "Continue directly from
  the prose above" — never "write a story about…", which invites a cold open in the model's
  default voice.
- **Name the failure once, negatively and concretely**: "do not drift toward the register of
  these instructions or the summaries" — then stop. Repetition of style warnings is itself
  register pollution.
- **No output preamble is demanded or forbidden** — the parser discards chatter, so templates
  don't spend tokens (or model attention) policing it.

### 5.3 Instructions vs prose, per task kind

| Surface | Where the user's words go | Framing |
|---|---|---|
| instructed-continue box | `<user-instructions>` inside `<task>` | "stage directions for what happens next — follow them; do not copy their wording into the manuscript (dialogue they explicitly quote may be used)" |
| quick-edit box | `<user-instructions>` inside `<task>`; the selection as `<selection-excerpt>` + in-place `<selection>` markers | instruction is a directive; the excerpt is a pointer, not a style exhibit |
| edit-task pane (M2) | `<user-instructions>` (long form) + `<edit-target/>` refs | same |
| situation pane | `<situation>` region | "the user's scene notes: an outline and constraints, not story text; satisfy them, never transcribe them" |

The framing sentences live in the system prompt (§6.1) once, not per-region — matching the
frontend's rule that every instruction-entry surface is visually distinct from prose entry
(04 §instruction surfaces).

---

## 6. Templates (v0 — subject to profiling)

Templates live in `prompts/` as Markdown files with `{{slot}}` substitution, hot-reloaded in
dev (05 §layout). Slots are filled by the engine (regions) or the handler (ids, directives).
The concatenated template set is content-hashed and the hash recorded in every run's
`meta.params.promptsHash` (§9). All wording below is **v0**: it ships, gets profiled, and gets
rewritten — the grammar is the contract, the prose is not.

### 6.1 `system.md` — all interactive kinds, per-work stable

```markdown
You are the co-writing partner on a novel-length manuscript. You continue the story and revise
passages on request, always in the manuscript's own voice.

## Reading the prompt

The prompt is organized into tagged regions. Tags are structural markers; the text inside them
is Markdown. What is manuscript and what is not:

- Text inside <snippet>, <excerpt>, and any block marked fidelity="full" IS the manuscript:
  real prose, in the voice you must write in.
- Blocks marked fidelity="name", "short", or "long" are summaries ABOUT the manuscript —
  reference material in a plain register. Rely on them for facts; never imitate their style.
- <world-info> entries are out-of-voice notes on characters, places, and concepts.
- <situation> is the user's scene notes: an outline and constraints for the current scene.
  Satisfy them; never transcribe them.
- <user-instructions> is the user telling you what should happen or change. These are stage
  directions, not story text. Follow them; do not copy their wording into the manuscript
  (dialogue they explicitly quote may be used).

## Voice

The manuscript's voice is defined by its prose — the excerpts in <voice-anchors> and the recent
text in <local-context> — and by nothing else. Match that prose: rhythm, diction, sentence and
paragraph length, dialogue style, tense, and point of view. Do not drift toward the register of
these instructions or the summaries. When in doubt, reread the last lines of <local-context>
and continue as that writer would.

## Tools

While planning you may call tools: context_expand opens a section or world entry at more
detail; context_search finds exact phrases across the manuscript and notes. Open only what you
need — context is budgeted, and the budget line after each result tells you where you stand.
If you already have what you need, just start writing. If you opened or relied on items, call
finish_planning first and cite them.

## Output

Your final answer is one or more tag blocks — exactly the block(s) named in <instructions>,
with ids echoed verbatim. Opening and closing tags each on their own line; Markdown prose
inside; no code fences, no tags within a block. Anything outside the expected blocks is
discarded.
```

### 6.2 `continue.md` — `<instructions>` + `<task>` for continue / instructed-continue

The `<instructions>` block is the §4 example verbatim. The `<task>` region:

```not-xml
<task kind="continue">
Continue the story directly from the end of <local-context>.
</task>
```

Instructed variant (same `<instructions>` bytes; only `<task>` differs):

```not-xml
<task kind="instructed-continue">
Continue the story directly from the end of <local-context>. The user's instructions for what
happens next:
<user-instructions>
{{instruction}}
</user-instructions>
</task>
```

### 6.3 `quick-edit.md`

`<instructions>`:

```markdown
## This task: quick edit

Rewrite one passage according to the user's instruction. The target snippet is marked
role="edit-target" in <local-context>; the user's selected text is bracketed by
<selection>…</selection> inside it.

Rewrite the WHOLE target snippet: apply the instruction, keep everything the instruction does
not touch word-for-word, keep the voice, and keep continuity with the snippets before and
after it.

Output exactly one block, echoing the target's id:

<snippet id="{{targetId}}">
…the complete rewritten snippet…
</snippet>
```

`<task>`:

```not-xml
<task kind="quick-edit">
Edit snippet {{targetId}}.
<user-instructions>
{{instruction}}
</user-instructions>
The user selected this text (also marked in place):
<selection-excerpt>
{{selectionText}}
</selection-excerpt>
</task>
```

### 6.4 `edit-task.md` (M2)

As quick-edit, generalized: the `<task>` region lists `<edit-target/>` references and carries
the long-form `<user-instructions>`; frozen-section targets add the `<target>` region
(`<before>/<span>/<after>`, `<p n/>` markers) below `<local-context>`, and the instructions
name one output block per target (`<snippet id="…">` or `<span section="…" from="…" to="…">`),
with the rules: rewrite each span completely; never emit `<p/>` markers or the
`<before>/<after>` text; a target you cannot improve is returned unchanged rather than omitted.

### 6.5 `enrich.md` — background, low model, no tools (05 §background assembly)

```not-xml
<instructions>
You are preparing navigation aids for a finished chapter of a novel. Read the chapter in
<target>; the summaries in <global-context> cover what came before.

Produce, in this order:

<title> — a human-readable chapter name, at most 8 words, no spoilers beyond this chapter.
<summary-short> — 2–4 sentences (≤ 120 words): who, what changed, and where it leaves off.
<summary-long> — 1–3 paragraphs (≤ 400 words): events in order, motivations, and every concrete
fact a later scene might call back to — names, objects, promises, injuries, dates.

Rules: summaries are plain, factual reference prose in present tense — do not imitate the
chapter's voice. Never state anything the chapter (plus the earlier summaries) does not
establish. <summary-short> must contain nothing that is absent from <summary-long>. Each block's
tags on their own lines; no other text.
</instructions>
<world-info>
{{matchedEntries}}          # ≤ 8 entries, name + summary fidelity
</world-info>
<global-context>
{{precedingSiblingShorts}}  # ≤ 2 <section fidelity="short"> blocks
</global-context>
<target>
<section id="{{sectionId}}" name="{{sectionName}}" fidelity="full">
{{content}}
</section>
</target>
```

When the section's title is user-pinned, the `<title>` line is dropped from the instructions
and the parser treats an emitted `<title>` as unexpected (05 §enrich).

### 6.6 `boundaries.md` — background, low model

```not-xml
<instructions>
You divide a run of manuscript passages into sections. Read the snippets in <local-context>
(each carries its id); <global-context> shows how the previous sections were cut.

Propose boundaries as one <boundaries> block containing only JSON:

<boundaries>
{"boundaries":[{"afterSnippetId":"<id>","kind":"chapter","title":"<≤ 8 words>"}]}
</boundaries>

Rules: a boundary may fall only at the end of a listed snippet. Prefer breaks the text itself
signals — scene changes, time skips, viewpoint shifts, a closing beat. Chapters should land
between {{minWords}} and {{maxWords}} words; do not cut mid-scene to hit a size. Leaving the
newest snippets unassigned is correct — never place a boundary after the final snippet.
</instructions>
<global-context>
{{lastTwoFrozenShorts}}
</global-context>
<local-context>
{{eligibleSnippets}}
</local-context>
```

### 6.7 The refresh turn (wording; shape owned by 06 §refresh)

```not-xml
<local-context-refresh>
{{lastRefreshTailTokens of local-context, verbatim}}
</local-context-refresh>
Planning is over. Continue directly from the prose above, in its voice — not from the summaries
or the tool results. No tool calls. Output only the block(s) named in <instructions>.
```

### 6.8 `repair.md` — the one corrective turn (05 §repair)

```markdown
Your reply did not contain the required {{blockList}} block(s). Reply again with only the
required block(s) — opening tag on its own line, content, closing tag on its own line — and no
other text.
```

---

## 7. The writing-stage output contract (restated for prompt authors)

Normative home: 05 §output-contract. What every template must convey, consistently:

1. **Whole-target rewrite.** Each block is the *complete replacement text* for one
   harness-designated target — never a diff, never search/replace, never "…unchanged…"
   ellipses. Preservation is expressed by reproducing the untouched text verbatim.
2. **Targets are named by the harness**, and the model echoes them: `id="new"` for a fresh
   snippet, the prompt's ULID for a rewrite, the exact `section/from/to` for a span. A block
   whose id matches nothing declared is dropped.
3. **One page per continue** (300–700 words, end on a beat) — one `<snippet id="new">` block;
   multiple blocks from a continue are rejected (05 §continue).
4. **Tags alone on their lines, Markdown inside, no fences, no nested tags.** Chatter outside
   blocks is legal and discarded; templates neither demand nor forbid it.
5. **One repair turn** exists (§6.8); templates should be written so it is rarely needed — the
   block spec appears in `<instructions>` *with a literal filled-in example*, since models copy
   shapes far more reliably than they follow descriptions.

---

## 8. Image prompts (composition wording; loop owned by 08)

The illustration composer and reviser run on the low model with the region order fixed in 08
§compose (`<instructions>`, `<world-info>`, `<established-imagery>`, `<guidance>`, `<target>`)
and output a single `<image-prompt>` block. The content rules — 08's, restated as the template's
voice:

```markdown
## This task: write the image prompt for one illustration

Read the scene material in <target>. Then:

1. Pick ONE concrete visual moment — a single scene at a single instant, not a montage.
2. Write one flowing descriptive paragraph, 60–120 words, present tense: subject first, then
   action, setting, lighting, mood, and framing (e.g. "wide shot", "close portrait").
3. Content only. No tag lists, no quality boilerplate ("masterpiece", "8k", "trending"), no
   negative phrasing ("no blur"), no artist names, no resolution or camera-gear words. Style
   belongs to the rendering workflow, not the prompt.
4. People and places listed in <established-imagery> keep their exact wording: copy their
   physical descriptions verbatim, word for word.
5. Never rely on proper names — the image model cannot ground them. Describe the person or
   place physically; a name may follow the description only as decoration ("— Mara —").
6. If <guidance> is present, it wins over everything except rule 3.

Output exactly one block:

<image-prompt>
…the paragraph…
</image-prompt>
```

The reviser (`illustrate-revise.md`) receives the same brief plus the previous prompt and the
critic's actionable instruction, and is told to keep the same moment and change only what the
critique names. The critic (`illustrate-critique.md`) is the one JSON-emitting template in the
system — it returns `CritiqueResult` in a fenced JSON block, per 08 §critic, because its
consumer is a Zod parser, not a splice; prose-bearing outputs stay in tag blocks, judgments may
be JSON. Attempt loop, scoring, budget, and commit semantics: 08 §loop.

---

## 9. Profiling & iteration

The wording above is deliberately v0. The brief's position — perfect prompts *after* there is
something to play with — is designed in: everything needed to profile and iterate is already
recorded, and every knob is a file edit.

**What is logged, and what it answers:**

| Signal | Source | Question it answers |
|---|---|---|
| per-region token counts, per task | `ContextSnapshot.regions` in run `meta` (05 §runs); `task_start.regions` in `usage.jsonl` (06 §usage) | which regions dominate cost; whether anchors/skeleton budgets are sized right |
| `cache_break` events naming the region | `usage.jsonl` (06 §usage) | real prefix-hit rates per region; whether the stability ordering earns its keep; whether per-kind `<instructions>` causes kind-switch misses (§5.1) |
| provider-reported cache hits | `usage` run events — when an endpoint returns `prompt_tokens_details.cached_tokens`, it is recorded alongside our estimate | ground truth to calibrate `cache_break` inference against |
| planning rounds, tool calls, expand sizes | `task_end` / `tool_call` usage events; `toolCall` run events | whether templates prompt too much or too little tool use; result-cap sizing |
| `output_invalid` + repair-turn frequency | run `attempt`/`result` events, error taxonomy (05 §errors) | which templates fail the output contract; whether the literal-example rule (§7.5) is working |
| voice drift | run transcripts (the full prompt and output are in every run file) | manual review: sample continues across a long work, compare against anchors |
| template identity | `meta.params.promptsHash` — content hash of the loaded `prompts/` set, stamped on every run | attributes any metric shift to the exact template version; enables before/after comparison across template edits |

**Iteration loop:** edit a file in `prompts/` (hot-reloaded in dev, restart in prod — 00
§runtime), run tasks, read `usage.jsonl` and run files, compare across `promptsHash`. No
schema, code, or migration involved.

**Standing candidates for revision, in expected order:** the per-kind `<instructions>` vs
kind-invariant trade (§5.1); refresh-tail size (`refreshTailTokens`) vs voice quality after
tool-heavy plans; anchor total and excerpt count (06 §knobs); continue length wording (models
under- or over-shoot the 300–700 band differently); the enrich summary length caps; and the
tool-nudging sentences in `system.md` (too eager and every task pays planning rounds, too shy
and the model contradicts off-screen chapters).

---

## 10. Contracts

This subsystem owns **no shared Zod schemas**. Its contract surface is the grammar, the
canonical strings, and the template files.

Owned here:

| Contract | Consumers |
|---|---|
| Tag grammar: region / item / marker / output-block tags, attributes, line-anchoring, sanitize and no-escaping rules (§1–§3) | 05 (`TagBlockParser` grammar, §7 rules), 06 (region rendering, tool-result wrapping, marker tags), 08 (`<image-prompt>`, compose regions), 02 (run transcripts contain this markup, opaque to storage) |
| Canonical region-name strings (§2.1) | 06 (`ContextSnapshot.regions`, `usage.jsonl` keys), 04 §provenance (renders whatever names appear; never hardcodes the list) |
| `prompts/*.md` wording: `system.md`, `continue.md`, `quick-edit.md`, `edit-task.md`, `enrich.md`, `boundaries.md`, `repair.md`, `illustrate-compose.md`, `illustrate-revise.md`, `illustrate-critique.md`; refresh-turn wording (§6.7) | 05 (loads and fills interactive/background templates; stamps `promptsHash`), 06 (refresh turn bytes), 08 (illustration templates) |
| Voice-preservation and instruction-delineation rules (§5.2–§5.3) | 05/06 (assembly honors them), 04 (instruction-surface styling mirrors the delineation) |

Consumed from elsewhere:

| Contract | Owner | Used for |
|---|---|---|
| Region ordering, region contents, refresh-turn shape, budget status lines, anchor selection | 06 §assembly, §tools, §anchors | the order and payloads the grammar decorates |
| Expected-blocks-per-kind table, commit semantics, repair-turn mechanics, `promptsHash` recording | 05 §output-contract, §repair, §runs | which output blocks each template must specify |
| `BoundaryProposal` JSON shape | 02 §boundaries | the `<boundaries>` block payload |
| `CritiqueResult`, composer content rules, intent-brief inputs | 08 §compose, §critic | illustration template payloads |
| `usage.jsonl` events, `ContextSnapshot` | 06 §usage, 05 §runs | the profiling feed (§9) |

# Web Frontend Architecture & Interaction Design — Subsystem Design

**App:** Cowrite — illustrated co-writing with an LLM ("simple, modern, snappy")
**Subsystem owner:** Web frontend (`apps/web`)
**Status:** Proposal v1 (2026-07-06)

> **Provenance note.** The brief path supplied to this task resolved to `undefined`; the product
> brief was located at `docs/00-overview.md` in the repo (its document map names this doc
> `04-frontend.md`) and is treated as authoritative, including the fixed stack (Vite 7, React 19,
> Fastify 5, `packages/shared` Zod contract, SSE, Playwright). Where this doc touches other
> subsystems it aligns with the sibling proposals `docs/design/data-model.md` and
> `docs/design/context-engine.md`; every dependency is listed in
> [§16 Interface assumptions](#16-interface-assumptions).

---

## 1. Scope and principles

This doc specifies everything that runs in the browser: state architecture, the document view
(virtualized, progressively collapsing), editing and selection interactions, frontier controls and
streaming, the three side surfaces (situation pane, edit-task pane, world-info panel), rendering
(markdown, dialogue tint, world-key highlighting, provenance coloring), illustrations, the keyboard
model, and the e2e strategy.

Frontend-local principles, derived from the brief:

1. **Frontier-first.** The bottom of the document is the product. It must feel like a fast chat
   app; everything above it may "merely work."
2. **The server is the truth; the client is a cache + a cursor.** No client-only durable state
   beyond UI preferences. Every mutation is an API call; SSE keeps the cache honest.
3. **One scroll surface.** The whole work is a single virtualized document — no tabs per chapter,
   no pagination. Collapse, don't hide.
4. **Plaintext editing.** No WYSIWYG, no contentEditable. Textareas over markdown source.
5. **Subtle, not decorated.** Coloring (dialogue, provenance, world keys) is tint and underline
   weight, never boxes and badges everywhere.
6. **Testable without models.** Every flow drivable by Playwright against the mock-LLM server.

---

## 2. Libraries (additions to the fixed stack)

The brief fixes Vite 7 + React 19 + `@cowrite/shared` (Zod). New runtime dependencies for
`apps/web`, all small and boring:

| Dep | Version | Role | Rejected alternative (why) |
|---|---|---|---|
| `@tanstack/react-query` | ^5 | Server state, optimistic mutations | SWR (weaker mutation/optimistic story); Redux Toolkit Query (ceremony) |
| `zustand` | ^5 | Local UI state (selection, folds, streaming buffers) | Jotai (atom soup for what is 3 stores); React context (re-render blast radius) |
| `react-router` | ^7 (library mode) | 4 routes + modal route | TanStack Router (excellent, but codegen'd route trees are overkill for 4 routes); hand-rolled hash router (we want deep links + back button correctness for free) |
| `@tanstack/react-virtual` | ^3 | Document-view virtualization | `react-virtuoso` (good chat support but fights our custom fold-transition anchoring); `react-window` (no dynamic-height story worth using) |
| `react-markdown` + `remark-gfm` | ^9 / ^4 | Markdown → React elements (per block) | `markdown-it` + `dangerouslySetInnerHTML` (loses React event handlers for hovercards; XSS surface); ProseMirror/Milkdown (we render markdown, we don't WYSIWYG-edit it) |
| `@floating-ui/react` | ^0.27 | Hovercards, selection toolbar positioning | Popper v2 (legacy); hand positioning (edge-flip math is a solved problem) |
| `gpt-tokenizer` | shared | Token estimates in edit-task meter (same estimator as server, per context-engine §8.3) | — |

Styling: **plain CSS modules + CSS custom properties** for theming (light/dark via
`prefers-color-scheme` + manual override). *Rejected:* Tailwind (fine, but the doc-view needs
long-form typographic CSS that reads better as stylesheets); CSS-in-JS runtimes (payload + churn).

No global state library beyond the two above. No form library (three textareas do not need one).

---

## 3. Routes and directory layout

### 3.1 Routes

```
/                          WorksList        — list/create/open works
/w/:workId                 WorkView         — document view + panes (the app)
/w/:workId/world           WorkView         — world-info panel open, entry list
/w/:workId/world/:entryId  WorkView         — world-info panel open, entry detail
/w/:workId/runs/:runId     WorkView         — provenance viewer as a modal route
```

The world panel and provenance viewer are **routes** (deep-linkable, back-button closes them).
The situation pane and edit-task pane are **local UI state** (persisted per work in
`localStorage`) — they are working surfaces, not places you link to.

### 3.2 Directory tree (`apps/web/src`)

```
src/
  main.tsx                    # router + QueryClientProvider + theme bootstrap
  routes/
    WorksList.tsx
    WorkView.tsx              # layout shell: panes grid + DocView + event wiring
  api/
    client.ts                 # thin fetch wrapper: baseUrl, Zod parse, ApiError
    queries.ts                # all useQuery/useMutation hooks + queryKeys factory
    events.ts                 # SSE connection, event→cache reducer (§4.3)
  state/
    docUiStore.ts             # zustand: selection, editing, folds, follow-bottom
    taskStore.ts              # zustand: active task stream buffer + phase
    panelStore.ts             # zustand(persist): pane visibility, widths, per-work
  doc/
    DocView.tsx               # virtualizer host, scroll anchoring, keyboard scope
    useDocBlocks.ts           # tree+snippets → Block[] with fold levels (§5.2)
    foldPolicy.ts             # pure: distance→FoldLevel, override merge (§5.3)
    anchoring.ts              # scroll-anchor bookkeeping (§5.5)
    blocks/
      SectionBlock.tsx        # renders one section at its fold level
      SnippetBlock.tsx        # chat-like frontier block
      FrontierBar.tsx         # controls: new/continue/instruct (§8)
      StreamingBlock.tsx      # in-progress generation display
      SectionHeader.tsx       # title, fold widget, staleness badge
      NameCard.tsx            # name+illustration collapsed card
  render/
    Markdown.tsx              # react-markdown config, memoized per block
    rehypeDecorate.ts         # dialogue + world-key + spellcheckless spans (§6)
    dialogue.ts               # pure: paragraph → dialogue ranges
    worldMatcher.ts           # pure: Aho–Corasick over world keys (§6.3)
    Hovercard.tsx             # world-entry hovercard (floating-ui)
  edit/
    SnippetEditor.tsx         # textarea editor (dbl-click flow, §7.1)
    SelectionToolbar.tsx      # floating widgets on single-click select (§7.2)
    RevisionCycler.tsx        # ◀ rev k/n ▶ + restore (§7.3)
    QuickEditBox.tsx          # one-line instruct-edit on selection (§7.2)
  panes/
    SituationPane.tsx         # left pane (§9.1)
    EditTaskPane.tsx          # right pane: instructions + pickers + meter (§9.2)
    world/
      WorldPanel.tsx          # list + detail routes (§9.3)
      EntryEditor.tsx
      EntryImage.tsx
  runs/
    RunViewer.tsx             # provenance modal (§7.4)
    RunStep.tsx
  ui/                         # Button, Toast, Modal, Kbd, Skeleton — dumb atoms
  styles/
    tokens.css                # colors incl. provenance/dialogue tints, spacing
    doc.css                   # long-form typography (65ch measure, etc.)
  keyboard.ts                 # key map + context resolution (§11)
  testids.ts                  # every data-testid constant, shared with e2e
e2e/                          # Playwright (§14.2)
```

---

## 4. State architecture

### 4.1 Three layers, strict ownership

| Layer | Tool | Contents | Persistence |
|---|---|---|---|
| **Server state** | TanStack Query | works, section tree, snippets, section content, world entries, revisions, runs, context candidates/previews | server; client cache invalidated/patched by SSE |
| **Session UI state** | Zustand (in-memory) | selection, editing draft, streaming buffers, follow-bottom flag | none (except editor draft crash-copy, §7.1) |
| **Preferences** | Zustand + `persist` → `localStorage` | fold overrides/pins per work, pane visibility/widths, theme | `localStorage["cowrite:ui:<workId>"]` |

Rule: a component never copies query data into a store. Stores hold IDs and ephemeral text only.

### 4.2 Query keys and endpoints consumed

Query key factory (all keys namespaced under the work):

```ts
export const qk = {
  works:        ()                    => ["works"] as const,
  work:         (w: string)           => ["work", w] as const,          // meta + settings
  sections:     (w: string)           => ["work", w, "sections"] as const, // full tree, light rows
  sectionText:  (w: string, s: string)=> ["work", w, "sectionText", s] as const,
  snippets:     (w: string)           => ["work", w, "snippets"] as const,
  revisions:    (w: string, s: string)=> ["work", w, "revisions", s] as const,
  situation:    (w: string)           => ["work", w, "situation"] as const,
  world:        (w: string)           => ["work", w, "world"] as const,   // list, light rows
  worldEntry:   (w: string, e: string)=> ["work", w, "world", e] as const,
  run:          (w: string, r: string)=> ["work", w, "run", r] as const,
  ctxCandidates:(w: string)           => ["work", w, "ctx", "candidates"] as const,
};
```

REST surface consumed (assumed contract with the API subsystem, cross-check §16):

| Method + path | Used by | Notes |
|---|---|---|
| `GET /api/works` / `POST /api/works` | WorksList | |
| `GET /api/works/:w` | WorkView | `WorkMeta` + settings |
| `GET /api/works/:w/sections` | doc view | tree of `SectionRow` (no prose) |
| `GET /api/works/:w/sections/:s/content` | doc view (lazy, §5.6) | `{ markdown, contentHash }` |
| `PATCH /api/works/:w/sections/:s/content` | behind-frontier edit | `{ markdown, baseHash }` → 409 on hash mismatch |
| `GET /api/works/:w/snippets` | doc view | all frontier snippets, full text (they're small) |
| `POST /api/works/:w/snippets` | new-empty-snippet | `{ text: "" }` → `SnippetDto` |
| `PATCH /api/works/:w/snippets/:s` | save edit | `{ text, baseRev }` → new rev; 409 on stale `baseRev` |
| `POST /api/works/:w/snippets/:s/restore` | rollback | `{ rev }` → appends a new revision with old text |
| `DELETE /api/works/:w/snippets/:s` | selection toolbar | |
| `GET /api/works/:w/snippets/:s/revisions` | revision cycler | full `RevisionEvent[]` |
| `GET /api/works/:w/situation` / `PUT …` | situation pane | markdown string |
| `GET /api/works/:w/world` (+ entry CRUD, `POST /world/:e/image`) | world panel | |
| `POST /api/works/:w/tasks` | all agent actions | `{ type, ... }` → `{ taskId, runId }` |
| `POST /api/works/:w/tasks/:t/cancel` | cancel button | |
| `GET /api/works/:w/runs/:r` | provenance viewer | parsed run events |
| `GET /api/works/:w/context/candidates`, `POST …/context/preview` | edit-task pane | from context-engine §9.2 |
| `GET /api/works/:w/events` | SSE (§4.3) | single connection per open work |

Defaults: `staleTime: 30s` for lists, `Infinity` for `sectionText` and `run` (immutable-ish,
invalidated by SSE), `retry: 1`, all responses Zod-parsed at the client boundary
(`api/client.ts`) so a contract break fails loudly in dev.

### 4.3 SSE → cache reducer

One `EventSource` per open work, opened by `WorkView`, with `Last-Event-ID` resume. Event types
and their exact cache effects (this table *is* the implementation of `api/events.ts`):

| SSE event | Payload | Cache action |
|---|---|---|
| `snippet.created` | `SnippetDto` | `setQueryData(qk.snippets)`: insert by `orderKey` (skip if id exists — could be our own optimistic insert) |
| `snippet.revised` | `SnippetDto` | patch item in `qk.snippets`; drop `qk.revisions(s)` |
| `snippet.deleted` | `{ id }` | remove from `qk.snippets` |
| `section.changed` | `SectionRow` | patch row in `qk.sections`; invalidate `qk.sectionText(s)` if `contentHash` changed |
| `sections.restructured` | — | invalidate `qk.sections` (consolidation, split/merge, reorder) |
| `consolidation.applied` | `{ sectionIds, undoToken, title }` | invalidate `qk.sections` + `qk.snippets`; toast “Chapter frozen — Undo” (data-model §6.3) |
| `enrichment.updated` | `{ sectionId, kind }` | patch row (summary text/stale flags) in `qk.sections`; if `kind==="illustration"` bust the image URL (`?v=<hash>`) |
| `world.changed` | `{ entryId? }` | invalidate `qk.world` (+ entry); bump `worldVersion` → rebuild key matcher (§6.3) |
| `situation.changed` | `{ text }` | `setQueryData(qk.situation)` unless pane has local dirty edits |
| `task.started` | `TaskStartedEvt` | taskStore: begin stream |
| `task.delta` | `{ taskId, text }` | taskStore: append to buffer (throttled flush, §8.3) |
| `task.tool` | `{ taskId, label }` | taskStore: push planning note ("opened Chapter 7") |
| `task.artifact` | `{ taskId, artifact }` | apply like the matching `*.created/updated` event |
| `task.completed` / `task.failed` / `task.cancelled` | `{ taskId, error? }` | taskStore: end stream; on failure toast with error |
| `readonly.changed` | `{ readonly, reason }` | banner (second-instance lock, data-model §9.3) |
| *(heartbeat comment every 15 s)* | — | liveness; 2 missed → reconnect |

Reconnect policy: exponential backoff 0.5 s → 8 s; on reconnect where the server reports a gap
(unknown `Last-Event-ID`), invalidate **all** `["work", w]` queries — brute force is fine on
localhost. `overflow-anchor` and streaming interplay are handled in the doc view, not here.

### 4.4 Zustand stores (sketches)

```ts
// state/docUiStore.ts — session-scoped, not persisted
export type FoldLevel = "full" | "long" | "short" | "name";       // = shared Fidelity
type BlockRef = { kind: "snippet" | "section"; id: string };

interface DocUiState {
  selection: BlockRef | null;                     // single-click select (§7.2)
  editing: (BlockRef & { draft: string; baseRev?: number; baseHash?: string }) | null;
  peekRevision: { snippetId: string; rev: number } | null;  // revision cycling (§7.3)
  followBottom: boolean;                          // stick-to-frontier flag (§5.5)
  select(ref: BlockRef | null): void;             // selecting clears peekRevision
  beginEdit(ref: BlockRef, initial: string): void;// clears selection (brief requirement)
  updateDraft(text: string): void;                // also mirrors to localStorage crash copy
  endEdit(): void;
}

// state/panelStore.ts — persisted per work
interface PanelState {
  situationOpen: boolean;  situationWidth: number;   // default: false, 320
  editTaskOpen: boolean;   editTaskWidth: number;    // default: false, 360
  foldOverrides: Record<string /*sectionId*/, FoldLevel | "auto">;
  setFold(sectionId: string, level: FoldLevel | "auto"): void;
}

// state/taskStore.ts — one active generation at a time (server serializes per work)
interface TaskState {
  active: null | {
    taskId: string; runId: string;
    type: "continue" | "instructed_continue" | "quick_edit" | "edit_task"
        | "enrichment" | "illustration";
    phase: "planning" | "writing";
    buffer: string;                 // streamed text so far (flushed at ~30 Hz, §8.3)
    toolNotes: string[];            // "opened Chapter 7", "searched \"storm glass\""
    startedAt: number;
  };
}
```

### 4.5 Shared DTO sketches (`packages/shared`)

The frontend consumes these; they wrap the data-model's on-disk types into API rows:

```ts
export const FoldLevelZ = z.enum(["full", "long", "short", "name"]); // = context Fidelity

export const SectionRow = z.object({
  id: Ulid, parentId: Ulid.nullable(), kind: z.string(), orderKey: OrderKey,
  title: z.string().nullable(), titleSource: z.enum(["user", "agent"]),
  isLeaf: z.boolean(), wordCount: z.number().int(),
  contentHash: Hash.nullable(),
  shortSummary: z.string().nullable(),   // inlined: small, needed for fold rendering
  longSummary: z.string().nullable(),    // inlined too (a few paragraphs; tree stays <1 MB)
  hasIllustration: z.boolean(), illustrationVersion: z.string().nullable(), // for cache-busting
  stale: z.object({ short: z.boolean(), long: z.boolean(), illustration: z.boolean() }),
});

export const SnippetDto = z.object({
  id: Ulid, orderKey: OrderKey, text: z.string(), rev: z.number().int(),
  authorship: z.enum(["user", "agent", "mixed"]),
  originRunId: Ulid.nullable(), updatedAt: IsoTime,
  revisionCount: z.number().int(),        // enables "rev 3/3" without extra fetch
});

export const TaskStartedEvt = z.object({
  taskId: Ulid, runId: Ulid, type: z.string(),
  target: z.object({ kind: z.enum(["frontier","snippet","section"]), id: Ulid.optional() }),
});
```

Both long and short summaries ship inside the tree response deliberately: they are what most of
the visible document *is* when scrolled back, and a 60-chapter tree with both summaries is well
under 1 MB — one request, zero waterfall. Only leaf `content.md` is lazy (§5.6).

---

## 5. The document view

The centerpiece: one virtualized scroll surface rendering the entire work, novel-length, with
progressive collapse toward the top and a chat-like frontier at the bottom.

### 5.1 Visual ladder (top → bottom)

```
┌──────────────────────────────────────────────┐
│ [img] Book One — name-only cards…            │  name: illustration inline, title, 1-line hook
│ [img] Ch. 1  The Lighthouse Keeper           │
│ ─ Ch. 7  The Ferry ─────────────── (short)   │  short: title + 1–3 sentence summary
│   Mara crosses at night; the glass cracks.   │
│ ─ Ch. 8  Salt in the Wound ──────── (long)   │  long: title + few-paragraph summary
│   ¶¶¶ …                                      │
│ ─ Ch. 9  The Storm Glass ──────────  (full)  │  full: prose, illustration floated right
│   full markdown text……………………      ┌────┐    │
│   ………………………………………………………           │img │    │
│                                    └────┘    │
│ ╭─ snippet (agent) ─────────────────────╮    │  frontier: chat-like blocks
│ ╰────────────────────────────────────────╯   │
│ ╭─ snippet (user) ──────────────────────╮    │
│ ╰────────────────────────────────────────╯   │
│ ▌streaming block… ▍                          │
│ [ + snippet ]  [ Continue ⌃⏎ ]  [ Instruct…] │  frontier bar (in-flow, last block)
└──────────────────────────────────────────────┘
```

Typography: 65ch measure, centered column (`max-width: 68ch`), 17 px/28 px body. Snippets get a
subtle container (hairline border, 6 px radius, authorship tint on the left edge at 2 px);
sections get no container — they read as book text with a slim heading rule.

### 5.2 Block model

`useDocBlocks()` flattens server state into a render list — a pure memo over
`(sections, snippets, foldOverrides, activeTask)`:

```ts
type Block =
  | { kind: "sectionHeader"; section: SectionRow; fold: FoldLevel; depth: number }
  | { kind: "sectionBody";   section: SectionRow; fold: Exclude<FoldLevel,"name"> }
  | { kind: "nameCard";      section: SectionRow }              // fold === "name"
  | { kind: "snippet";       snippet: SnippetDto }
  | { kind: "streaming" }                                        // present iff task writing prose
  | { kind: "frontierBar" };                                     // always the last block
```

Walk the section tree in document order (parent before children, `orderKey` sort). Interior
(non-leaf) sections emit only a `sectionHeader`; leaves emit header + (`sectionBody` |
`nameCard`). Then all frontier snippets by `orderKey`, then `streaming?`, then `frontierBar`.
Header and body are **separate blocks** so the virtualizer can keep a sticky-ish header cheap and
so body height changes don't remeasure headers.

MVP renders the flat `["chapter"]` scheme (data-model §2.1); the depth field and header
indentation already handle deeper schemes.

### 5.3 Fold-level policy

Distance-based defaults + manual override, mirroring the context engine's fidelity ladder so the
user's view and the model's view agree (context-engine §4).

**Distance metric:** `d` = number of *leaf* sections between this leaf and the frontier
(the last leaf has `d = 0`). Word counts were rejected as the metric: they make fold boundaries
creep mid-session as the frontier grows, causing surprise re-layout; section count is stable and
predictable.

```ts
// doc/foldPolicy.ts (pure, unit-tested)
export function defaultFold(d: number): FoldLevel {
  if (d <= 1)  return "full";    // the 2 most recent chapters: real prose
  if (d <= 5)  return "long";    // next 4: long summaries
  if (d <= 13) return "short";   // next 8: short summaries
  return "name";                 // deep past: name + illustration card
}
export function effectiveFold(s: SectionRow, d: number, o: Record<string, FoldLevel|"auto">) {
  const ov = o[s.id];
  const base = ov && ov !== "auto" ? ov : defaultFold(d);
  // graceful degradation when enrichment lags: never render an empty body
  if (base === "long"  && !s.longSummary)  return s.shortSummary ? "short" : "full";
  if (base === "short" && !s.shortSummary) return "name";
  return base;
}
```

Interior sections: `name` when **all** descendant leaves are `name` (the whole part collapses to
one card); otherwise render as a plain header. (Trivial in MVP's flat scheme.)

**Manual control:** each `SectionHeader` carries a fold widget — four dots
`[● ● ● ●] auto` for `full/long/short/name` plus an `auto` reset. Clicking sets a **pin**: a
persistent override in `panelStore.foldOverrides` (survives reload via localStorage). Pins are
per-work and never expire on their own — the widget shows a small pin glyph when non-auto.
*Rejected:* a separate transient "expand once" mode (two mechanisms for one idea; a pin you can
reset to `auto` covers it), and click-title-to-toggle (conflicts with click-to-select, §7.2).

Defaults are exported as one constants object (`FOLD_DEFAULTS = { full: 2, long: 4, short: 8 }`)
so profiling can tune them; no settings UI in MVP.

### 5.4 Virtualization

`@tanstack/react-virtual` with dynamic measurement over the `Block[]` list:

- `estimateSize(i)` from block kind before first measurement (all in px):
  - `snippet`: `72 + ceil(words / 11) * 28` (11 words/line at 65ch/17 px is measured, not folklore — verify once in a layout test)
  - `sectionBody full`: same formula on `wordCount` (before lazy text arrives, §5.6)
  - `sectionBody long`: formula on the summary's word count; `short`: `~3 lines ≈ 84 + 56`
  - `nameCard`: fixed `96`; `sectionHeader`: fixed `44`; `frontierBar`: fixed `88`
- `measureElement` (ResizeObserver) corrects estimates as blocks mount and as images load.
- `overscan: 6` blocks each side.
- The scroll element is the document column itself, `overflow-anchor: none` (we own anchoring).

Only ~15–25 blocks are ever mounted; markdown parsing + decoration cost is bounded regardless of
work length.

### 5.5 Scroll anchoring (the hard part)

Collapsed heights differ by two orders of magnitude (a `name` card is 96 px; the same chapter at
`full` is 15,000 px). Three things mutate heights above the viewport: lazy section text arriving,
fold changes (pins, or `d` shifting when a consolidation adds a section), and image loads.
Native `overflow-anchor` can't be trusted across virtualizer item remounts, so:

```
// doc/anchoring.ts — runs inside useLayoutEffect, before paint
state: anchor = { blockKey, offsetPx } | null    // topmost block intersecting viewport top

onScroll (user-initiated):
  anchor = topmost block with blockBottom > scrollTop
  anchor.offsetPx = blockTop(anchor) - scrollTop            // ≤ 0
  followBottom = (scrollHeight - scrollTop - clientHeight) < 48

afterMeasurementsChange (virtualizer re-layout committed):
  if followBottom: scrollTo(bottom); return                  // frontier stickiness wins
  if anchor exists and anchor block still in list:
      scrollTop = blockTop(anchor) - anchor.offsetPx         // restore exact visual position
  else (anchor block removed, e.g. consolidation replaced snippets):
      fall back to its section's header block, offset 0
```

Rules that make this feel right:

- **Opening a work** scrolls to bottom (`followBottom = true`) — frontier-first.
- **Scrolling up** breaks `followBottom`; the `End` key or the "↓ frontier" floating button
  (appears whenever `!followBottom`) restores it.
- **Expanding a section you clicked** anchors to *that section's header* (not the topmost
  visible block), so the thing you asked to read stays put while everything below grows.
- Streaming append (§8.3) only ever grows the *bottom*; with `followBottom` it auto-scrolls,
  without it nothing moves.
- Illustrations always render with reserved aspect-ratio boxes (`aspect-ratio` CSS from known
  image dimensions in `SectionRow`) so image loads never shift layout at all — anchoring is the
  backstop, not the plan.

### 5.6 Lazy section text

Leaf prose is fetched only when needed:

- `SectionBlock` at fold `full` mounts → `useQuery(qk.sectionText)` fires; until data arrives it
  renders a skeleton sized by the word-count estimate (so anchoring math already holds).
- **Prefetch triggers:** hovering a section header for 150 ms, or focusing its fold widget,
  prefetches content (`queryClient.prefetchQuery`) — expanding then feels instant.
- `staleTime: Infinity`; invalidation comes solely from `section.changed` SSE events keyed on
  `contentHash`.
- Response also carries `contentHash`, which the behind-frontier editor uses as `baseHash` for
  optimistic-concurrency on save (409 → theirs/mine prompt, data-model §8).

---

## 6. Rendering pipeline

### 6.1 Markdown

`react-markdown` + `remark-gfm`, one instance per block, memoized on
`(contentHash | snippet.rev, worldVersion, decorationsEnabled)`. Allowed elements: the prose set
(paragraphs, emphasis, headings ≤ h4, blockquote, lists, hr, code) — raw HTML disabled
(`skipHtml`), links render as plain text with the URL in a tooltip (this is a novel, not a wiki;
also kills the XSS/link-hijack class). Scene-break `***`/`---` renders as a centered ✳ ✳ ✳
ornament.

### 6.2 Decoration pass: one rehype plugin

`rehypeDecorate` walks the hast tree once per block and splits text nodes into spans. It applies,
in one pass: dialogue ranges, world-key matches, and (that's it — provenance tinting is
block-level, §6.4). Custom `components` map then renders `span.dlg` and `span.wi` with handlers.

**Dialogue detection — client-side, pure function** (`render/dialogue.ts`):

```
detectDialogue(paragraphText) -> Array<[start, end]>
  scan for opening quotes: " or “ ; closing: matching " or ” .
  a range opens at a quote preceded by start/whitespace/punct and closes at the
  matching quote; an unclosed quote closes at paragraph end (common in drafts).
  ranges include the quote marks themselves.
```

Per-paragraph only (no cross-paragraph state) — cheap, cacheable, and wrong in exactly the rare
cases (multi-paragraph quotations) where being wrong is invisible at this subtlety level.
Styling: `--dlg` tint — a slight hue rotation of body text (e.g. light theme
`color: oklch(0.42 0.06 250)` vs body `oklch(0.32 0.01 250)`), no background. *Rejected:*
per-speaker colors (needs attribution — an LLM job, fiddly, deferred); server-side dialogue
spans (couples render cosmetics to storage; the regex is 30 lines).

### 6.3 World-key highlighting + hovercards

Requirements: match potentially hundreds of keys over all *visible* text, highlight subtly,
hovercard with entry summary + thumbnail, click navigates to the entry.

- **Matcher:** an Aho–Corasick automaton (`render/worldMatcher.ts`, ~120 lines, no dep) built
  from all `keys[]` of all entries, case-insensitive, word-boundary-checked on both ends.
  Build cost O(total key chars) — rebuilt only when `worldVersion` bumps (world SSE event).
  Scan cost O(text length) per block, done inside `rehypeDecorate`, memoized with the block.
  With virtualization only mounted blocks (~25 × ≤2k words) are ever scanned; a full remount
  scans ~50k chars — sub-millisecond. *Rejected:* one giant `RegExp` alternation (quadratic
  blowups with many keys, no clean word boundaries for multi-word keys); server-side match spans
  (stale the moment a key is edited; ships trivially recomputable data).
- Only the **first match per entry per block** is decorated (repeated highlights of "Mara" forty
  times per scene is noise).
- **Style:** `span.wi` gets a 1 px dotted underline in a muted accent, normal text color.
- **Hovercard:** one global `Hovercard` (floating-ui) opens after 350 ms hover: entry name,
  `shortSummary`, 48 px thumbnail if the entry has an image, and “open ↗”. Click (or Enter when
  focused) navigates to `/w/:workId/world/:entryId`. Card content comes from the already-loaded
  `qk.world` list — zero fetch on hover.
- Decorations are suppressed inside the editor (it's a plain textarea anyway) and inside
  streaming text until the task completes (avoid rescanning per delta).

### 6.4 Provenance coloring

Always-on, whisper-quiet: each snippet's 2 px left edge is tinted by authorship
(`user` `--prov-user` blue-gray, `agent` `--prov-agent` violet-gray, `mixed` a vertical
gradient of both). On **selection** (§7.2) the tint strengthens and the snippet background gets a
2% authorship-tinted wash, and the selection toolbar names it explicitly ("agent · run 01J2… ·
rev 3/3"). While **revision-peeking**, the peeked revision's author tints the block instead.
Frozen sections show no per-passage provenance in MVP (per-snippet history collapsed at
consolidation); the section header's ⋯ menu offers "History…" opening the consolidated
provenance list from `history.jsonl` data — deferred, §15.

---

## 7. Editing and selection

### 7.1 Double-click → edit

Double-click on a snippet or a `full` section body replaces the rendered block, in place, with a
plaintext editor:

- Auto-growing `<textarea>` (`field-sizing: content` with a JS fallback), monospace **off** —
  same body font as rendered text, so the swap is calm; markdown shown as source.
- **Enter** = newline. **Ctrl-Enter** = save. **Esc** or the ✕ cancel button = cancel
  (if dirty, one inline confirm: "Discard changes? [Discard] [Keep editing]").
- Entering edit mode **clears selection** (brief requirement) and any revision peek.
- Save = optimistic: patch the query cache immediately, `PATCH` with `baseRev`/`baseHash`;
  409 → rollback cache, toast "Changed elsewhere — reloaded", editor stays open with the draft
  so nothing is lost.
- **Crash copy:** the draft mirrors to
  `localStorage["cowrite:draft:<workId>:<blockId>"]` (throttled 500 ms), cleared on
  save/cancel; on mount, a leftover draft offers "Restore unsaved edit?".
- One revision per save. The data-model's 2 s-idle "accepted edit" debounce (its §6.1) is
  interpreted as the *server-side coalescing rule for autosaving editors*; this frontend uses
  explicit commit instead — flagged for cross-check in §16 (A3).

### 7.2 Single-click → select

Single click on a snippet (or section body) selects it — no caret, no editor:

- The block gets the provenance wash (§6.4) and a **selection toolbar** floats at its top-right
  (floating-ui, stays within viewport): provenance chip (click → provenance viewer, §7.4),
  revision cycler (§7.3), delete (snippets only, with confirm), and a "＋ Situation" button
  when there's also a text-range selection inside the block (§9.1).
- Below the block, a **quick-edit box** appears: a one-line input, placeholder
  *"Tell the agent how to change this passage…"*, distinct instruction styling (§8.2). Ctrl-Enter
  launches a `quick_edit` task targeting the selected block; the block shimmers while the task
  runs and the result arrives as a new revision (SSE), with the cycler showing "rev 4/4 ↩".
- Click elsewhere, Esc, starting an edit, or starting any frontier task clears selection.
- Selection is **one block** in MVP. Multi-select (shift-click range → edit-task targets) is
  structured for — `selection` becomes `BlockRef[]` — but deferred.

### 7.3 Revision cycling / rollback

The cycler in the selection toolbar: `◀ rev 3/3 ▶`.

- First interaction fetches `qk.revisions(snippetId)` (full texts — snippets are small).
- Stepping back sets `peekRevision` and the block renders that revision's text with a thin
  "viewing rev 2 of 3 — [Restore] [Latest]" banner. Peeking is purely visual; nothing is written.
- **Restore** calls `POST …/restore { rev: 2 }` → the server appends a *new* revision whose text
  is rev 2 (history is never rewritten), optimistic-updated locally. Alt+←/→ cycles from the
  keyboard (§11).
- Sections: no cycling in MVP (no per-section history behind the frontier; data-model §6.5).

### 7.4 Provenance viewer (agent-run display)

Route `/w/:workId/runs/:runId`, a wide modal. It renders one `AgentRun` (parsed run JSONL from
`GET /runs/:r`) as a **vertical timeline**, not a raw transcript:

```
┌ Run 01J2P7Q4 · draft · high model (claude-…) · 6,412 in / 388 out · 13.2 s ─┐
│ ▸ Prompt (5 regions, 6.4k tokens)          [collapsed by default]           │
│    ▸ instructions (412 tok)  ▸ world-info (1.8k)  ▸ global-context (2.9k)…  │
│ ● opened Chapter 7 — The Ferry (context_expand, full, 1,043 tok)            │
│ ● searched "storm glass" → 6 matches                                        │
│ ● finished planning — cited: Ch. 7, Mara Voss                               │
│ ▾ Output                                                                    │
│    Mara pressed her palm against the storm glass…                           │
│ ● produced: snippet a2 rev 1   [jump to snippet]                            │
└──────────────────────────────────────────────────────────────────────────────┘
```

- Header: kind, model, token usage, duration, status (ok / error / cancelled — errors show the
  message prominently).
- Prompt regions collapse independently, labeled with the context-engine region names and token
  counts (context-engine §5.1) — the user can see *exactly* what the model saw, one click deep.
- Tool calls render as timeline steps with human labels; expanding a step shows raw input/output.
- Artifacts link back into the document (scroll-to + flash the snippet).
- Entry points: provenance chip on selection; each revision row in the cycler; "how was this
  written?" in the streaming block's ⋯ menu after completion.

---

## 8. Frontier controls & streaming

### 8.1 The frontier bar

The last block in the scroll surface (in-flow, so it reads as "the next thing after the text"):

```
[ ＋ snippet ]        [ Continue  ⌃⏎ ]        [ ✎ Instruct… ────────────── ⌃⏎ ]
```

- **＋ snippet** — creates an empty snippet and opens it directly in the editor (one round-trip;
  optimistic block appears instantly). This is how the user writes.
- **Continue** — launches a `continue` task. Also triggered by **Ctrl-Enter when nothing is
  selected and no editor is open** (the brief's global gesture).
- **Instruct…** — an input that expands into a 3-row textarea on focus.

### 8.2 Instruction styling (never looks like story text)

Everywhere the user types *instructions* (instruct-continue box, quick-edit box, edit-task pane,
situation pane), the surface is visually distinct from prose: UI sans-serif font (body prose is
serif), amber-tinted background (`--instr-bg`), a small ✎ glyph and an "instruction" microlabel,
left-aligned ragged text. Prose surfaces are serif on paper-white. This one consistent contrast
carries the whole "am I writing story or steering the agent?" distinction.

Instruct-continue: type instruction, Ctrl-Enter → `instructed_continue` task. The instruction
text stays visible in the streaming block header ("↳ *make the storm arrive early*") and is
recorded in the run (visible later in provenance).

### 8.3 Streaming display

On `task.started` with a prose-producing type, a `StreamingBlock` appears above the frontier bar:

- **Planning phase:** a compact activity line cycling the `task.tool` notes
  ("planning — opened Chapter 7…"), with a cancel ✕. No fake prose.
- **Writing phase:** deltas append into the block with a blinking caret glyph; the block is
  styled like an agent snippet but slightly translucent until committed.
- Delta handling: SSE `task.delta` events accumulate in a ref; a 33 ms rAF-aligned flush writes
  to state (≈30 fps, keeps React commits off the token firehose).
- With `followBottom` the view tracks growth; otherwise a "↓ writing…" pill floats bottom-right.
- On `task.completed`, the `task.artifact`/`snippet.created` event swaps the streaming block for
  the real snippet (keyed swap, no flicker). On `task.failed`/`cancelled`, partial text is kept
  in the block with "[Keep as snippet] [Discard]".
- The frontier bar's task buttons disable while a task runs (server serializes tasks per work;
  the UI reflects it rather than queuing).

---

## 9. Panes and panels

Layout grid (all widths persisted):

```
┌───────────┬──────────────────────────────┬───────────────┐
│ Situation │        Document view         │  Edit task    │  + WorldPanel as an
│ (left,    │        (center, own          │  (right,      │    overlay sheet from
│  optional)│         scroll)              │   optional)   │    the right (routed)
└───────────┴──────────────────────────────┴───────────────┘
```

### 9.1 Situation pane (left)

- Toggle: header button or `Ctrl+;`. Width 320 px default, drag-resizable 240–480.
- **Own scroll container**, independent of the document.
- One markdown textarea (instruction styling, §8.2), always editable — no edit mode; it's a
  scratchpad. Saves via `PUT /situation`, debounced **1,000 ms** after idle plus on blur;
  a subtle "saved" tick confirms. Incoming `situation.changed` SSE only applies when not dirty.
- **Easy copy from main text:** selecting a text range in the document view raises a mini
  floating button "＋ Situation" (next to the native selection); clicking appends the selection
  to the pane as a markdown blockquote with a `— Ch. 9` attribution line. Plain
  select-copy-paste also works everywhere (no `user-select` games anywhere in the doc view).

### 9.2 Edit-task pane (right)

For deliberate, targeted edits (bigger than quick-edit). Toggle: `Ctrl+'` or "Edit task…" in the
selection toolbar (which pre-fills the target).

Contents, top to bottom:

1. **Instructions** — multi-line textarea, instruction styling.
2. **Target** — the selected block(s), shown as removable chips ("Ch. 9 · ¶ selection",
   "snippet a1"). Empty target = frontier (the task becomes an instructed continue with edit
   framing — the pane says so).
3. **Context pickers** — two collapsible checklists fed by `GET /context/candidates`
   (context-engine §9.2): the section tree and the world-entry list, each row showing name +
   per-fidelity token counts, with a fidelity dropdown (`short/long/full`) on checked rows.
   Rows already elevated by the ledger come pre-checked (from `currentFidelity`).
4. **Token meter** — a horizontal bar: assembled estimate vs `softBudget` (32k) and `hardCap`
   (64k) with the numbers printed. Fed by `POST /context/preview`, debounced **300 ms** after
   any change; turns amber past soft, red past `0.9 × hard` and disables launch with the
   engine's structured message ("Selection exceeds the context limit…", context-engine §8.2).
5. **[Run edit task]** (Ctrl-Enter within the pane).

Progress streams like any task; results arrive as revisions to targeted snippets/sections via
SSE and flash-highlight on arrival.

### 9.3 World-info / context panel

Routed overlay sheet from the right (560 px, over the edit-task pane if open), `Ctrl+.` or the
"World" header button.

- **List view** (`/world`): search-as-you-type filter (client-side over the loaded list),
  rows = 40 px thumbnail (or a glyph), name, key count, one-line summary. "＋ New entry."
- **Entry view** (`/world/:entryId`):
  - name (inline-editable), **keys** as a chip editor (add/remove strings),
  - **image**: displayed 320 px wide; buttons *Generate* / *Regenerate* (launches an
    `illustration` task for the entry; progress via task SSE; skeleton shimmer meanwhile) and
    *Remove*,
  - `shortSummary` one-line field,
  - **body**: markdown textarea (double-click-to-edit like the doc? No — always-editable
    textarea with rendered preview toggle; entries are working documents). Ctrl-Enter saves,
    Esc reverts; same 409-on-stale handling as sections.
- Back button / Esc closes to list, then closes the panel (router-driven).
- Deleting an entry confirms and shows count of key matches currently visible ("'Mara Voss'
  is referenced by 2 keys in view").

---

## 10. Illustrations

- **Section at `full`:** the illustration floats right of the text at the section's top
  (`float: right; width: min(320px, 40%)`), caption-less, hairline border. Body text wraps.
- **`long`/`short`:** a small 96 px thumbnail top-right of the summary block.
- **`name`:** the illustration *is* the card — 96 px image left, title + first summary sentence
  right (see §5.1). No illustration yet → a deterministic placeholder (initials on a hue derived
  from the section id hash) so cards stay scannable.
- **States:** `stale.illustration` → tiny ⟳ badge with tooltip "outdated — regenerate" (menu
  action); generation in progress (enrichment/illustration task SSE) → shimmer overlay on the
  reserved box; failed → placeholder + retry in the ⋯ menu.
- Click → lightbox (full resolution, section title, [Regenerate] [Close]).
- `src = /api/works/:w/sections/:s/illustration?v=<illustrationVersion>` — version param makes
  browser caching exact; `enrichment.updated` bumps it.
- Every `<img>` sits in an `aspect-ratio` reserved box (dimensions in `SectionRow`), so loads
  never shift layout (§5.5).

---

## 11. Keyboard model

One resolver (`keyboard.ts`) dispatches by context, most-specific first; contexts are: editor
open → quick-edit/instruct/pane input focused → selection active → global. All bindings shown in
a `?`-key cheat sheet.

| Context | Key | Action |
|---|---|---|
| Editor open | `Enter` | newline (never submits) |
| | `Ctrl-Enter` | save |
| | `Esc` | cancel (confirm if dirty) |
| Instruction inputs (instruct/quick-edit/edit-task) | `Ctrl-Enter` | launch that task |
| | `Esc` | blur/clear the box |
| Selection active | `Alt-←` / `Alt-→` | cycle revisions |
| | `Esc` | clear selection (also exits revision peek) |
| | `Ctrl-Enter` | launch quick edit if its box has text; else no-op (never falls through to Continue while something is selected) |
| Global (work view) | `Ctrl-Enter` | Continue (nothing selected, no editor) |
| | `End` / `Ctrl-End` | jump to frontier, re-arm followBottom |
| | `Ctrl+;` / `Ctrl+'` / `Ctrl+.` | toggle situation / edit-task / world panel |
| | `Esc` | close topmost surface (modal → panel → nothing) |
| | `?` | shortcut cheat sheet |

Deliberately absent in MVP: vim-style navigation, Ctrl-K command palette (structured for —
`keyboard.ts` is a table — but the brief's ethos says resist), custom rebinding.

---

## 12. Snappiness tactics

| Tactic | Where | Number |
|---|---|---|
| Optimistic cache writes with rollback | snippet save/create/delete/restore, world edits | perceived 0 ms |
| SSE echo-dedupe | reducer skips events whose `(id, rev)` already in cache | no double flash |
| Debounced saves | situation 1,000 ms; edit-task preview 300 ms; draft crash-copy 500 ms | |
| Prefetch | section text on header hover (150 ms); world list on work open; revisions on toolbar mount | |
| rAF-batched stream flush | task deltas | ~30 fps commits |
| Virtualization | 15–25 mounted blocks regardless of work size | |
| Memoized markdown+decorations | keyed on `(rev|contentHash, worldVersion)` | re-render of one block never re-parses others |
| Store selector subscriptions | blocks subscribe to `selection?.id === myId`, not the store | selection change re-renders 2 blocks |
| Reserved image boxes | `aspect-ratio` everywhere | zero CLS |
| Single SSE connection | per open work | no polling |

Startup: `GET /works/:w` + sections + snippets + world fire in parallel from route loaders;
the document renders on sections+snippets (world decorations pop in a beat later if slower).

---

## 13. Failure modes

| Failure | Behavior |
|---|---|
| SSE drops | backoff reconnect (0.5→8 s) with `Last-Event-ID`; gap → invalidate all work queries; >10 s down → thin offline banner |
| Server restarted mid-task | heartbeat loss ends the stream; streaming block shows "connection lost — [Keep partial] [Discard]"; on reconnect, task state re-derived from queries |
| 409 on save (stale rev/hash) | rollback optimistic write, reload, keep draft open, toast |
| External-edit conflict prompt | server-driven theirs/mine choice surfaces as a modal (data-model §8); "mine" resubmits with fresh baseHash |
| Task failure | toast with run error; provenance viewer link for the full story |
| Illustration 404/failed | placeholder + retry menu |
| Zod parse failure on a response | dev: throw loudly; prod: toast "client/server version mismatch — reload" |
| Read-only mode (second instance) | `readonly.changed` banner; all mutating controls disabled, viewing/scrolling fully functional |
| Very long single section (100k words) at `full` | render is virtualized *between* blocks only; cap: sections >20k words render `full` as the first 20k + "Open remainder" expander (rare; consolidation keeps sections chapter-sized) |

---

## 14. Testing

### 14.1 Unit / component (Vitest + Testing Library, jsdom)

Pure modules first — they carry the tricky logic: `foldPolicy` (table-driven distance→level +
override + degradation), `dialogue` (quote pairing incl. unclosed/curly), `worldMatcher`
(boundaries, overlaps, case, multi-word keys, first-per-block), `anchoring` (simulated height
mutations preserve anchor math), `useDocBlocks` (tree+snippets→blocks snapshots), SSE reducer
(each event row of §4.3 as a test case against a seeded QueryClient). Component tests: editor
key handling, revision cycler, selection toolbar.

### 14.2 Playwright e2e

Lives in `apps/web/e2e`; runs against the **real server** with mock OpenAI/ComfyUI endpoints
(brief principle 6; testing subsystem owns the mocks) and a temp data dir per test file.

```ts
// playwright.config.ts (essentials)
webServer: {
  command: "COWRITE_DATA_DIR=$(mktemp -d) COWRITE_MOCK_LLM=1 pnpm --filter @cowrite/server start",
  url: "http://127.0.0.1:8787/api/health",
},
projects: [{ name: "chromium", use: devices["Desktop Chrome"] }],   // localhost app: one browser in CI
```

Fixtures: `e2e/fixtures/` holds two seed work directories — `tiny` (2 snippets) and
`novel` (30 frozen chapters + summaries + images, generated by a script) — copied into the data
dir per test. The mock LLM is scripted per test via a control endpoint
(`POST /__mock/llm/enqueue` with canned deltas/tool-calls).

Key flows (each one spec file):

1. **write-and-continue** — create work → ＋ snippet → type → Ctrl-Enter save → Continue →
   planning notes appear → streamed text appears → block commits; assert snippet count,
   authorship tint testid, followBottom autoscroll.
2. **edit-cycle-rollback** — double-click, edit, save; Alt-← shows rev 1; Restore → rev 3
   exists with rev-1 text; provenance chip opens run viewer showing the mock prompt regions.
3. **fold-ladder** — open `novel` fixture; assert the ladder (2 full / 4 long / 8 short / rest
   name) via testids; pin a `name` chapter to `full`; assert lazy content request fired and
   scroll position of the pinned header is preserved (±2 px) after expansion; reload → pin
   persisted.
4. **anchoring-under-load** — scroll to mid-document, trigger consolidation via API, assert
   viewport anchor block unchanged.
5. **instruct-and-quick-edit** — instruct-continue with instruction visible in stream header;
   select a snippet → quick edit → new revision arrives.
6. **world-flow** — create entry with key "storm glass" → underline appears in visible prose →
   hovercard shows summary → click navigates to entry → generate image (mock ComfyUI) →
   thumbnail appears.
7. **edit-task-meter** — open pane, check sections until the meter passes soft budget (amber),
   assert number matches `POST /context/preview` response; launch and assert task ran with
   selections (via `/context/state`).
8. **resilience** — kill/restart server mid-stream via control endpoint; assert keep/discard
   choice then normal operation after reconnect.

Selectors: `data-testid` constants from `src/testids.ts` only — shared import, so renames break
compile, not CI. Waits: always on visible state (`toHaveText`, `toBeVisible`), never timeouts.

---

## 15. MVP cut

**Ships first (the product):**

- Works list; work view; single virtualized doc with fold ladder + pins + anchoring +
  lazy section text; followBottom/jump-to-frontier
- Snippet create/edit (dbl-click, Ctrl-Enter/Esc), select, delete, revision cycle + restore
- Continue / instructed continue / quick edit with streaming display, cancel, keep-partial
- Provenance viewer (timeline form)
- Situation pane with copy-from-selection; edit-task pane with pickers + live token meter
- World panel: list, entry edit, keys, image display + generate
- Rendering: markdown, dialogue tint, world-key underlines + hovercards, provenance edge tints,
  staleness badges, consolidation undo toast, read-only banner
- Illustrations right-of-text / inline cards, lightbox, regenerate
- Keyboard model of §11; light/dark theme

**Structured-for, deferred:**

- Multi-select targets for edit tasks (`selection: BlockRef[]`)
- Frozen-section provenance history view (`history.jsonl` timeline) and behind-frontier
  revision UI
- Ctrl-K palette over server FTS5; per-speaker dialogue coloring; command cheat-sheet search
- Consolidation *review* mode UI (auto+undo ships); un-freeze section action
- Mobile/narrow layout (panes become sheets); settings UI for fold defaults and budgets
  (JSON/config only in MVP); virtualized >20k-word single-section remainder expander polish

---

## 16. Interface assumptions

To cross-check against `01-architecture.md`, `03-api.md`, and the sibling designs:

- **A1 — API subsystem** provides the REST table of §4.2 and the SSE event vocabulary of §4.3
  (names negotiable; the *semantics* — per-event payloads sufficient for cache patching without
  refetch, `Last-Event-ID` resume, heartbeats — are required). DTOs live in `packages/shared`
  and match §4.5, notably: summaries inlined in `SectionRow`, `revisionCount` on `SnippetDto`,
  `illustrationVersion` + image dimensions for cache-busting and reserved boxes.
- **A2 — Data model** (per its proposal): ULID ids, `orderKey` fractional ordering (client
  inserts sort lexicographically), snippet revisions are append-only full texts, restore
  appends, consolidation emits an undo token, `contentHash` optimistic concurrency on section
  writes, theirs/mine conflict prompt is UI-surfaced. Frozen sections have no per-revision
  history (frontend hides cycling there).
- **A3 — Edit-commit semantics (divergence to resolve):** data-model §6.1 defines "accepted
  edit = 2 s idle debounce"; this design uses explicit commit (Ctrl-Enter) producing exactly one
  revision per save, with crash-safety handled client-side via localStorage drafts.
  Recommendation: server keeps the debounce rule only for any future always-live editors; the
  `PATCH` endpoint treats each call as one revision.
- **A4 — Context engine** (per its proposal): `GET /context/candidates` returns per-item
  per-fidelity token counts + `defaultFidelity`/`currentFidelity`; `POST /context/preview`
  returns `{ totalTokens, perRegion, overSoft, overHard }` within 100 ms for a 60-chapter work;
  task tool-calls surface as SSE `task.tool` events with human-readable labels; edit-task
  selections are passed on `POST /tasks` as `{ selections: [{id, fidelity}], targetIds }` and
  recorded with source `user`/`target`. Fold ladder constants intentionally mirror its default
  fidelity map; if its defaults move, `FOLD_DEFAULTS` moves with them.
- **A5 — Agent/task runner**: one task per work at a time (UI disables, doesn't queue);
  `task.delta` carries plain text prose only; planning activity is separately typed; partial
  output on cancel/failure is included in the terminal event so "keep as snippet" can commit it
  via the normal snippet-create endpoint.
- **A6 — Enrichment/illustration**: illustrations are served per section/entry by the API with
  stable URLs + version params; image pixel dimensions are known server-side and included in
  rows; `moodTag`/`dialogueRatio` are *not* needed by the frontend.
- **A7 — Testing subsystem**: provides mock OpenAI + ComfyUI servers bootable via
  `COWRITE_MOCK_LLM=1` and a control endpoint to enqueue scripted responses; provides (or
  accepts) the `novel` fixture generator.
- **A8 — Static hosting**: `apps/server` serves the built `apps/web/dist` (`@fastify/static` is
  already in the scaffold) at `/`, API under `/api`; Vite dev proxies `/api` to the server port
  so dev and prod share URLs.

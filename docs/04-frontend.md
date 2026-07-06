# 04 — Web Frontend: Architecture & Interaction Design

This document specifies everything that runs in the browser (`apps/web`): state architecture, the
virtualized document view with progressive collapse, editing and selection interactions, frontier
controls and streaming, the side surfaces (situation pane, edit-task pane, world panel), rendering
(markdown, dialogue tint, world-key highlighting, provenance coloring), illustrations, first-run
setup, the keyboard model, and the e2e strategy. Server behavior is referenced, never redefined:
the REST/SSE contract lives in 03-api.md, task semantics in 05-agents.md, context assembly in
06-context-engine.md.

**Key decisions**

- **TanStack Query + two small Zustand stores** — server state stays in one cache patched by SSE;
  UI state stays tiny and ephemeral, so there is no second source of truth to drift.
- **One virtualized scroll surface** for the whole work — collapse, don't paginate; navigation of
  a novel must not become tab management.
- **The fold ladder is UI ergonomics, owned here** — the model's context map is computed
  independently by the engine (06); the provenance viewer, not the fold state, shows what the
  model saw.
- **One interactive-task slot plus a background-task map** — background enrichment and
  illustration run concurrently with the flagship continue stream and must never corrupt it.
- **Mid-document edits shimmer and swap atomically** — no token-by-token rendering inside the
  document in MVP; deltas are buffered, the commit is the reveal (`task.delta` still carries
  `target` on the wire for later inline streaming).
- **Plaintext textareas, explicit Ctrl-Enter commits** — no contentEditable, no WYSIWYG; one save
  = one revision.
- **Keep-partial and edit conflicts resolve through the server proposal routes** — the commit
  path records agent authorship and the origin run; the client buffer is display-only.
- **Decorations are client-side pure functions** — dialogue regex and an Aho–Corasick key matcher
  over only the ~25 mounted blocks; trivially recomputable data is never shipped from the server.
- **Token math is server-side only** — the web renders numbers it is given (`/context/preview`);
  no tokenizer in the bundle.
- **Editor-open state is declared to the server** (`POST /editing`) — consolidation never freezes
  a snippet out from under an open editor.

---

## 1. Scope and principles

Frontend-local principles:

1. **Frontier-first.** The bottom of the document is the product. It must feel like a fast chat
   app; everything above it may "merely work."
2. **The server is the truth; the client is a cache + a cursor.** No client-only durable state
   beyond UI preferences. Every mutation is an API call; SSE keeps the cache honest.
3. **One scroll surface.** The whole work is a single virtualized document — no tabs per chapter,
   no pagination.
4. **Plaintext editing.** Textareas over markdown source; rendered markdown everywhere else.
5. **Subtle, not decorated.** Coloring (dialogue, provenance, world keys) is tint and underline
   weight, never boxes and badges everywhere.
6. **Testable without models.** Every flow drivable by Playwright against the mock-LLM server.

---

## 2. Libraries (additions to the fixed stack)

The stack fixes Vite 7 + React 19 + `@cowrite/shared` (Zod). New runtime dependencies for
`apps/web`, all small and boring:

| Dep | Version | Role | Rejected alternative (why) |
|---|---|---|---|
| `@tanstack/react-query` | ^5 | Server state, optimistic mutations | SWR (weaker mutation/optimistic story); Redux Toolkit Query (ceremony) |
| `zustand` | ^5 | Local UI state (selection, folds, streaming buffers) | Jotai (atom soup for what is 3 stores); React context (re-render blast radius) |
| `react-router` | ^7 (library mode) | 5 routes + modal route | TanStack Router (excellent, but codegen'd route trees are overkill here); hand-rolled hash router (we want deep links + back-button correctness for free) |
| `@tanstack/react-virtual` | ^3 | Document-view virtualization | `react-virtuoso` (good chat support but fights our custom fold-transition anchoring); `react-window` (no dynamic-height story worth using) |
| `react-markdown` + `remark-gfm` | ^9 / ^4 | Markdown → React elements (per block) | `markdown-it` + `dangerouslySetInnerHTML` (loses React handlers for hovercards; XSS surface); ProseMirror/Milkdown (we render markdown, we don't WYSIWYG-edit it) |
| `@floating-ui/react` | ^0.27 | Hovercards, selection toolbar positioning | Popper v2 (legacy); hand positioning (edge-flip math is a solved problem) |

No tokenizer ships in the bundle: all token numbers are computed server-side by the context
engine and delivered over the API (06 §8.3); the web only renders them.

Styling: **plain CSS modules + CSS custom properties** for theming (light/dark via
`prefers-color-scheme` + manual override). *Rejected:* Tailwind (fine, but the doc view needs
long-form typographic CSS that reads better as stylesheets); CSS-in-JS runtimes (payload + churn).

No global state library beyond the two above. No form library (a handful of textareas do not
need one).

---

## 3. Routes and directory layout

### 3.1 Routes

```
/                          WorksList        — list/create/open works
/settings                  Settings         — endpoint config cards; also the first-run screen
/w/:workId                 WorkView         — document view + panes (the app)
/w/:workId/world           WorkView         — world panel open, entry list
/w/:workId/world/:entryId  WorkView         — world panel open, entry detail
/w/:workId/runs/:runId     WorkView         — provenance viewer as a modal route
```

The world panel and provenance viewer are **routes** (deep-linkable, back-button closes them).
The situation pane and edit-task pane are **local UI state** (persisted per work in
`localStorage`) — they are working surfaces, not places you link to.

On app load, if `GET /api/config` reports `setup.highConfigured === false`, the router redirects
to `/settings` in first-run mode (§11).

### 3.2 Directory tree (`apps/web/src`)

```
src/
  main.tsx                    # router + QueryClientProvider + theme bootstrap
  routes/
    WorksList.tsx
    Settings.tsx              # first-run + endpoint cards (§11)
    WorkView.tsx              # layout shell: panes grid + DocView + event wiring
  api/
    client.ts                 # thin fetch wrapper: baseUrl, Zod parse, ApiError
    queries.ts                # all useQuery/useMutation hooks + queryKeys factory
    events.ts                 # SSE connection, WorkEvent → cache/store reducer (§4.3)
    editingSignal.ts          # POST /editing on editor open/close (§7.1)
  state/
    docUiStore.ts             # zustand: selection, editing, folds, follow-bottom
    taskStore.ts              # zustand: interactive slot + background map (§4.4)
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
      StreamingBlock.tsx      # in-progress frontier generation display
      SectionHeader.tsx       # title, fold widget, staleness badge
      NameCard.tsx            # name+illustration collapsed card
  render/
    Markdown.tsx              # react-markdown config, memoized per block
    rehypeDecorate.ts         # dialogue + world-key spans (§6)
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
    EditTaskPane.tsx          # right pane: instructions + pickers + meter (§9.2, M2)
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
  keyboard.ts                 # key map + context resolution (§12)
  testids.ts                  # every data-testid constant, shared with e2e
e2e/                          # Playwright (§15.2)
```

---

## 4. State architecture

### 4.1 Three layers, strict ownership

| Layer | Tool | Contents | Persistence |
|---|---|---|---|
| **Server state** | TanStack Query | works, section tree, snippets, section content, world entries, revisions, runs, config, context candidates/previews | server; client cache invalidated/patched by SSE |
| **Session UI state** | Zustand (in-memory) | selection, editing draft, task stream buffers, follow-bottom flag | none (except editor draft crash-copy, §7.1) |
| **Preferences** | Zustand + `persist` → `localStorage` | fold overrides/pins per work, pane visibility/widths, theme | `localStorage["cowrite:ui:<workId>"]` |

Rule: a component never copies query data into a store. Stores hold IDs and ephemeral text only.

**Stale-key garbage collection:** fold pins, crash-copy drafts, and store refs are keyed by
entity ULIDs that consolidation and deletion invalidate. One rule covers all of them: after the
refetch triggered by `sections.restructured`, `snippet.deleted`, or `consolidation.applied`, any
override/draft/ref whose id no longer resolves is dropped (drafts with content are surfaced once
as a "recovered text" toast with a copy action before being dropped).

### 4.2 Query keys and endpoints consumed

Query key factory (all keys namespaced under the work):

```ts
export const qk = {
  works:        ()                     => ["works"] as const,
  config:       ()                     => ["config"] as const,
  work:         (w: string)            => ["work", w] as const,            // meta + settings + readonly
  sections:     (w: string)            => ["work", w, "sections"] as const, // full tree, light rows
  sectionText:  (w: string, s: string) => ["work", w, "sectionText", s] as const,
  snippets:     (w: string)            => ["work", w, "snippets"] as const,
  revisions:    (w: string, s: string) => ["work", w, "revisions", s] as const,
  situation:    (w: string)            => ["work", w, "situation"] as const,
  world:        (w: string)            => ["work", w, "world"] as const,    // full entries (small)
  tasks:        (w: string)            => ["work", w, "tasks"] as const,    // resync/keep-partial
  run:          (w: string, r: string) => ["work", w, "run", r] as const,
  ctxCandidates:(w: string)            => ["work", w, "ctx", "candidates"] as const, // M2
};
```

There is no separate world-entry query: `GET /world` returns full entries (03 §3.5), so the
entry detail view and hovercards select from the list cache.

REST surface consumed (full contract in 03 §3):

| Method + path | Used by | Notes |
|---|---|---|
| `GET /api/works` / `POST /api/works` | WorksList | |
| `GET /api/works/:w` | WorkView | `WorkDetail`: meta + settings + `readonly` |
| `GET /api/works/:w/sections` | doc view | flat `SectionRow[]`, summaries inlined |
| `GET /api/works/:w/sections/:s/content` | doc view (lazy, §5.6) | `{ markdown, contentHash }` |
| `PATCH /api/works/:w/sections/:s/content` | behind-frontier edit | `{ markdown, baseHash }` → 409 on hash mismatch |
| `PUT /api/works/:w/sections/:s/summaries` | summary edit (section ⋯ menu) | user-authored enrichment |
| `GET /api/works/:w/snippets` | doc view | all frontier snippets, full text |
| `POST /api/works/:w/snippets` | new-empty-snippet | `{ text: "" }` → `SnippetDto` |
| `PATCH /api/works/:w/snippets/:s` | save edit | `{ text, baseRev }` → new rev; 409 on stale `baseRev` |
| `POST /api/works/:w/snippets/:s/restore` | rollback | `{ rev }` → appends a new revision with old text |
| `DELETE /api/works/:w/snippets/:s` | selection toolbar | |
| `GET /api/works/:w/snippets/:s/revisions` | revision cycler | full `RevisionEvent[]` |
| `POST /api/works/:w/editing` | editor open/close signal (§7.1) | `{ snippetId: Ulid \| null }` |
| `POST /api/works/:w/consolidations/:undoToken/undo` | undo toast (§4.3) | 409 `conflict` after grace expiry |
| `GET /api/works/:w/situation` / `PUT …` | situation pane | `PUT` carries `baseHash`; 409 → theirs/mine |
| `GET /api/works/:w/world` (+ entry CRUD, image upload/delete) | world panel | |
| `POST /api/works/:w/tasks` | all agent actions | `TaskSpec` → `202 Task`; 409 `busy` / `config_missing` |
| `POST /api/works/:w/tasks/:t/cancel` | cancel button | |
| `GET /api/works/:w/tasks` / `GET …/tasks/:t` | resync after reconnect | `partialText` on terminal tasks; in-memory — empty/404 after a server restart (recovery reads `GET /runs/:r`, §14) |
| `POST /api/works/:w/tasks/:t/proposal/apply` / `…/discard` | keep-partial + conflict card (§8.4) | reconstructed server-side from the run JSONL; no TTL |
| `GET /api/works/:w/runs/:r` | provenance viewer | parsed `RunEvent[]` |
| `GET /api/works/:w/context/candidates`, `POST …/context/preview` | edit-task pane (M2) | 06 §9.2; preview response includes effective `softBudget`/`hardCap` |
| `POST /api/works/:w/tasks/estimate` | edit-task pane pre-launch line (M2) | |
| `GET /api/config` / `PUT /api/config` / `POST /api/config/test` | Settings (§11) | |
| `GET /api/works/:w/events` | SSE (§4.3) | single connection per open work |

Defaults: `staleTime: 30s` for lists, `Infinity` for `sectionText` and `run` (immutable-ish,
invalidated by SSE), `retry: 1`, all responses Zod-parsed at the client boundary
(`api/client.ts`) so a contract break fails loudly in dev.

### 4.3 SSE → cache reducer

One `EventSource` per open work, opened by `WorkView`, with `Last-Event-ID` resume. The event
union is the shared `WorkEvent` (`packages/shared/src/events.ts`, presented in 03 §8.2); the
reducer imports it — this table maps each variant to its exact cache/store effect and *is* the
implementation of `api/events.ts`:

| SSE event | Payload (essentials) | Cache/store action |
|---|---|---|
| `snippet.created` | `{ snippet: SnippetDto }` | `setQueryData(qk.snippets)`: insert by `orderKey` (skip if id exists — SSE echo of our own POST) |
| `snippet.revised` | `{ snippet }` | patch item in `qk.snippets` (skip if `(id, rev)` already present); drop `qk.revisions(s)` |
| `snippet.deleted` | `{ id }` | remove from `qk.snippets`; clear/repair `docUiStore` refs pointing at it |
| `section.changed` | `{ section: SectionRow }` | patch row in `qk.sections`; invalidate `qk.sectionText(s)` if `contentHash` changed |
| `sections.restructured` | — | invalidate `qk.sections` (split/merge, reorder); GC stale keys (§4.1) |
| `consolidation.applied` | `{ sectionIds, title, undoToken }` | invalidate `qk.sections` + `qk.snippets`; clear dangling `docUiStore` refs; toast "Chapter frozen — Undo" wired to the undo route, auto-dismissed at the undo grace (work settings, default 5 min) |
| `consolidation.undone` | `{ sectionIds }` | invalidate `qk.sections` + `qk.snippets` |
| `enrichment.updated` | `{ sectionId, kind, section: SectionRow }` | patch the inlined row (summary text, staleness, illustration version/dimensions); if `kind === "illustration"`, the new `illustration.version` busts the image URL |
| `world.changed` | `{ entryId? }` | invalidate `qk.world` (undefined `entryId` ⇒ full refetch); bump `worldVersion` → rebuild key matcher (§6.3) |
| `situation.changed` | `{ text, updatedAt }` | `setQueryData(qk.situation)` unless the pane is dirty — then show a "changed on disk" chip (§9.1) |
| `readonly.changed` | `{ readonly, reason }` | banner; disable all mutating controls |
| `task.queued` | `{ task, position }` | taskStore: background queue badge (interactive never queues) |
| `task.started` | `{ task, target, lane }` | taskStore: route by `lane` — interactive slot vs background map (§4.4) |
| `task.stage` | `{ taskId, stage }` | interactive slot: flip `planning` ↔ `writing` display |
| `task.tool` | `{ taskId, name, label }` | interactive slot: push planning note ("opened Chapter 7") |
| `task.delta` | `{ taskId, target, text }` | append to that task's per-`target` buffer; only the frontier target renders live (§8.3) |
| `task.snapshot` | `{ taskId, target, text }` | replace that target's buffer (reconnect catch-up emitted by the server before live deltas resume, 03 §8.3) |
| `task.retrying` | `{ taskId, attempt, reason }` | streaming block shows "retrying…"; buffer for the target resets |
| `task.progress` | `{ taskId, phase, attempt, maxAttempts, pct }` | background map: illustration pipeline caption ("Generating (attempt 2/3, 64 %)") |
| `task.artifact` | `{ taskId, artifact }` | link artifact → block for flash-highlight; cache patching itself rides the domain events above |
| `task.usage` | `{ taskId, … }` | provenance viewer live figures |
| `task.completed` | `{ taskId }` | end that task's stream state; interactive: swap streaming block for the committed snippet (keyed swap, §8.3) |
| `task.cancelled` / `task.failed` | `{ taskId, partialText, code?, … }` | interactive: keep-partial surface (§8.4); background: quiet badge + activity log entry |
| `hello` / `resync` | — | `resync` ⇒ invalidate **all** `["work", w]` queries — brute force is fine on localhost. Task state re-derives from `GET /tasks` while the process lives (buffer-miss resync); after a server restart that list is in-memory-empty, so the watched task's state comes from `GET /works/:w/runs/:r` (run records are durable) and keep/discard resolves via the proposal apply/discard routes (03 §8.4) |
| *(heartbeat comment every 15 s)* | — | liveness; 2 missed → reconnect |

Reconnect policy: exponential backoff 0.5 s → 8 s with `Last-Event-ID`; a buffer miss or server
restart produces `resync` (03 §8.3). `overflow-anchor` and streaming interplay are handled in
the doc view, not here.

### 4.4 Zustand stores (sketches)

```ts
// state/docUiStore.ts — session-scoped, not persisted
export type FoldLevel = "full" | "long" | "short" | "name";   // alias of shared Fidelity
type BlockRef = { kind: "snippet" | "section"; id: string };

interface DocUiState {
  selection: BlockRef | null;                     // single-click select (§7.2)
  editing: (BlockRef & { draft: string; baseRev?: number; baseHash?: string }) | null;
  peekRevision: { snippetId: string; rev: number } | null;   // revision cycling (§7.3)
  followBottom: boolean;                          // stick-to-frontier flag (§5.5)
  select(ref: BlockRef | null): void;             // selecting clears peekRevision
  beginEdit(ref: BlockRef, initial: string): void;// clears selection; fires the editing signal
  updateDraft(text: string): void;                // also mirrors to localStorage crash copy
  endEdit(): void;                                // fires editing signal with null
}

// state/panelStore.ts — persisted per work
interface PanelState {
  situationOpen: boolean;  situationWidth: number;   // default: false, 320
  editTaskOpen: boolean;   editTaskWidth: number;    // default: false, 360 (pane ships M2)
  foldOverrides: Record<string /*sectionId*/, FoldLevel | "auto">;
  setFold(sectionId: string, level: FoldLevel | "auto"): void;
}

// state/taskStore.ts — ONE interactive task per work (server enforces via 409 busy);
// background/illustration tasks run concurrently and live in the map.
type TaskTarget = { kind: "frontier" | "snippet" | "section" | "entry"; id?: string };

interface TaskState {
  interactive: null | {
    taskId: string; runId: string;
    kind: "continue" | "instructed-continue" | "quick-edit" | "edit-task"; // shared TaskKind
    stage: "planning" | "writing";
    target: TaskTarget;
    buffers: Map<string, string>;   // per task.delta target; flushed at ~30 Hz (§8.3)
    toolNotes: string[];            // "opened Chapter 7", 'searched "storm glass"'
    startedAt: number;
  };
  background: Map<string /*taskId*/, {
    kind: string; target: TaskTarget;
    phase?: string; attempt?: number; maxAttempts?: number; pct?: number | null; // task.progress
  }>;
}
```

The SSE reducer routes `task.started` by the event's `lane` field; every subsequent `task.*`
event is routed by looking its `taskId` up in the slot or the map. A background `task.started`
arriving mid-stream therefore never touches the interactive slot — the flagship continue stream
is isolated by construction. Buttons in the frontier bar disable only while the *interactive*
slot is occupied; background work never blocks the user.

### 4.5 Shared DTOs consumed (`packages/shared`)

Normative definitions live with their owners (02 for storage rows, 03 for the API wrapping);
the shapes the frontend depends on:

```ts
export const Fidelity = z.enum(["name", "short", "long", "full"]);  // owned by 06; FoldLevel aliases it

export const SectionRow = z.object({
  id: Ulid, parentId: Ulid.nullable(), kind: z.string(), orderKey: OrderKey,
  title: z.string().nullable(), titleSource: z.enum(["user", "agent"]),
  isLeaf: z.boolean(), wordCount: z.number().int(),
  contentHash: Hash.nullable(),
  shortSummary: z.string().nullable(),   // inlined: small, needed for fold rendering
  longSummary: z.string().nullable(),    // inlined too (a few paragraphs; tree stays <1 MB)
  illustration: z.object({
    version: z.string(),                 // PNG content hash — regenerations always bump it
    width: z.number().int(), height: z.number().int(),   // reserved aspect-ratio boxes (§5.5, §10)
  }).nullable(),                         // null = none (incl. user-suppressed; no badge shown)
  stale: z.object({ short: z.boolean(), long: z.boolean(), illustration: z.boolean() }),
});

export const SnippetDto = z.object({
  id: Ulid, orderKey: OrderKey, text: z.string(), rev: z.number().int(),
  authorship: z.enum(["user", "agent", "mixed"]),
  originRunId: Ulid.nullable(), updatedAt: IsoTime,
  revisionCount: z.number().int(),        // enables "rev 3/3" without an extra fetch
});

export const ContextSnapshot = z.object({   // owned by 05 (packages/shared/src/runs.ts);
  // produced by 06 at assembly, stored in run meta
  regions: z.array(z.object({ name: z.string(), tokens: z.number().int() })),
  items: z.array(z.object({
    id: Ulid,
    kind: z.enum(["section", "snippet", "world", "situation", "anchor"]),
    fidelity: Fidelity, tokens: z.number().int(),
    source: z.enum(["default", "tool", "cite", "user", "target"]),
  })),
});
```

All ids are bare ULIDs; payloads that mix entity types (context candidates, snapshot items)
carry an explicit `kind` field rather than id prefixes.

Both summaries ship inside the tree response deliberately: they are what most of the visible
document *is* when scrolled back, and a 60-chapter tree with both summaries is well under 1 MB —
one request, zero waterfall. Only leaf `content.md` is lazy (§5.6).

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
`(sections, snippets, foldOverrides, interactiveTask)`:

```ts
type Block =
  | { kind: "sectionHeader"; section: SectionRow; fold: FoldLevel; depth: number }
  | { kind: "sectionBody";   section: SectionRow; fold: Exclude<FoldLevel, "name"> }
  | { kind: "nameCard";      section: SectionRow }              // fold === "name"
  | { kind: "snippet";       snippet: SnippetDto }
  | { kind: "streaming" }                     // present iff interactive task writing frontier prose
  | { kind: "frontierBar" };                  // always the last block
```

Walk the section tree in document order (parent before children, `orderKey` sort). Interior
(non-leaf) sections emit only a `sectionHeader`; leaves emit header + (`sectionBody` |
`nameCard`). Then all frontier snippets by `orderKey`, then `streaming?`, then `frontierBar`.
Header and body are **separate blocks** so the virtualizer can keep a sticky-ish header cheap
and body height changes don't remeasure headers.

MVP renders the flat `["chapter"]` scheme (02 §2.1); the depth field and header indentation
already handle deeper schemes.

### 5.3 Fold-level policy

Distance-based defaults + manual override. This ladder is **pure UI ergonomics** — it governs
what the *user* sees when scrolled back. The model's view is assembled independently by the
context engine from its own fidelity map (06 §4); the two are not coupled, and the provenance
viewer (§7.4) is where the model's actual view is inspected.

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
export function effectiveFold(s: SectionRow, d: number, o: Record<string, FoldLevel | "auto">) {
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
  - `snippet`: `72 + ceil(words / 11) * 28` (11 words/line at 65ch/17 px is measured, not
    folklore — verify once in a layout test)
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
- Illustrations always render with reserved aspect-ratio boxes (`aspect-ratio` CSS from the
  `illustration.width/height` in `SectionRow`) so image loads never shift layout at all —
  anchoring is the backstop, not the plan.

### 5.6 Lazy section text

Leaf prose is fetched only when needed:

- `SectionBlock` at fold `full` mounts → `useQuery(qk.sectionText)` fires; until data arrives it
  renders a skeleton sized by the word-count estimate (so anchoring math already holds).
- **Prefetch triggers:** hovering a section header for 150 ms, or focusing its fold widget,
  prefetches content (`queryClient.prefetchQuery`) — expanding then feels instant.
- `staleTime: Infinity`; invalidation comes solely from `section.changed` SSE events keyed on
  `contentHash`.
- Response also carries `contentHash`, which the behind-frontier editor uses as `baseHash` for
  optimistic-concurrency on save (409 → theirs/mine prompt, 02 §8).

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
in one pass: dialogue ranges and world-key matches (provenance tinting is block-level, §6.4).
A custom `components` map then renders `span.dlg` and `span.wi` with handlers.

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
hovercard with entry summary + thumbnail, click navigates to the entry. Keys are optional per
entry (`keys: []` is valid); entries without keys simply never highlight.

- **Matcher:** an Aho–Corasick automaton (`render/worldMatcher.ts`, ~120 lines, no dep) built
  from all `keys[]` of all entries, case-insensitive, word-boundary-checked on both ends.
  Build cost O(total key chars) — rebuilt only when `worldVersion` bumps (world SSE event).
  Scan cost O(text length) per block, done inside `rehypeDecorate`, memoized with the block.
  With virtualization only mounted blocks (~25 × ≤2k words) are ever scanned; a full remount
  scans ~50k chars — sub-millisecond. *Rejected:* one giant `RegExp` alternation (quadratic
  blowups with many keys, no clean word boundaries for multi-word keys); server-side match spans
  (stale the moment a key is edited; ships trivially recomputable data).
- **All matches per entry per block** are decorated (the brief: "any matches in the main text
  should be subtly indicated") — the Aho–Corasick pass already finds every occurrence, and the
  underline is quiet enough that repetition doesn't read as noise. Hovercard and click-to-navigate
  behavior is identical on every occurrence.
- **Style:** `span.wi` gets a 1 px dotted underline in a muted accent, normal text color.
- **Hovercard:** one global `Hovercard` (floating-ui) opens after 350 ms hover: entry name,
  `shortSummary`, 48 px thumbnail if the entry has an image, and "open ↗". When an entry has no
  `shortSummary`, the card falls back to the first ~3 lines of the entry body (per the brief; the
  body is already present in the world list cache). Click (or Enter when focused) navigates to
  `/w/:workId/world/:entryId`. Card content comes from the already-loaded `qk.world` list — zero
  fetch on hover.
- Decorations are suppressed inside the editor (it's a plain textarea anyway) and inside
  streaming text until the task completes (avoid rescanning per delta).

### 6.4 Provenance coloring

Always-on, whisper-quiet: each snippet's 2 px left edge is tinted by authorship
(`user` `--prov-user` blue-gray, `agent` `--prov-agent` violet-gray, `mixed` a vertical
gradient of both). On **selection** (§7.2) the tint strengthens and the snippet background gets a
2 % authorship-tinted wash, and the selection toolbar names it explicitly ("agent · run 01J2… ·
rev 3/3"). While **revision-peeking**, the peeked revision's author tints the block instead.
Frozen sections show no per-passage provenance in MVP (per-snippet history collapsed at
consolidation); the section header's ⋯ menu offers "History…" opening the consolidated
provenance list from `history.jsonl` data — deferred (§16).

---

## 7. Editing and selection

### 7.1 Double-click → edit

Double-click on a snippet or a `full` section body replaces the rendered block, in place, with a
plaintext editor:

- Auto-growing `<textarea>` (`field-sizing: content` with a JS fallback), monospace **off** —
  same body font as rendered text, so the swap is calm; markdown shown as source.
- The editor shows both a **Cancel** button and a **Save** button (Save labeled with the
  `Ctrl-⏎` hint) — the brief's explicit "cancel / save" controls. **Enter** = newline.
  **Ctrl-Enter** = save. **Esc** or Cancel = cancel (if dirty, one inline confirm:
  "Discard changes? [Discard] [Keep editing]").
- Entering edit mode **clears selection** and any revision peek (the brief fixes this:
  "opening a snippet for editing removes selection").
- **Editing signal:** opening a snippet editor fires `POST /works/:w/editing { snippetId }`;
  closing it (save/cancel/unmount) fires `{ snippetId: null }`. Fire-and-forget with one retry.
  Consolidation's eligible prefix excludes editor-open and task-targeted snippets (02 §6.2), so
  the passage under the cursor can never be frozen away mid-edit; the server also clears the
  flag when the work's SSE subscriber count drops to zero (03). Section editors don't signal —
  sections aren't consolidation inputs; their guard is `baseHash`.
- Save = optimistic: patch the query cache immediately, `PATCH` with `baseRev`/`baseHash`;
  409 → rollback cache, toast "Changed elsewhere — reloaded", editor stays open with the draft
  so nothing is lost.
- **Crash copy:** the draft mirrors to
  `localStorage["cowrite:draft:<workId>:<blockId>"]` (throttled 500 ms), cleared on
  save/cancel; on mount, a leftover draft offers "Restore unsaved edit?". Drafts whose block id
  no longer resolves follow the GC rule of §4.1.
- One revision per save: each `PATCH` call is one revision — the server does not debounce
  (03 §3.3).

### 7.2 Single-click → select

Single click on a snippet (or section body) selects it — no caret, no editor:

- The block gets the provenance wash (§6.4) and a **selection toolbar** floats at its top-right
  (floating-ui, stays within viewport): provenance chip (click → provenance viewer, §7.4),
  revision cycler (§7.3), delete (snippets only, with confirm), and a "＋ Situation" button
  when there's also a text-range selection inside the block (§9.1).
- Below a selected **snippet**, a **quick-edit box** appears: a one-line input, placeholder
  *"Tell the agent how to change this passage…"*, distinct instruction styling (§8.2).
  Ctrl-Enter launches a `quick-edit` task targeting the selected snippet; the block shows a
  "being rewritten" shimmer while the task runs (§8.3) and the result arrives as a new revision
  (SSE), with the cycler showing "rev 4/4 ↩".
- **MVP quick-edit rule:** the target is exactly **one frontier snippet**. Selecting a frozen
  section shows the toolbar (provenance, copy-to-situation) but the quick-edit box renders
  disabled with a hint ("Edits to frozen chapters use an edit task — coming in the edit-task
  pane"); section-span quick edits and multi-block selections ship in M2 with the edit-task
  pane. `selection` is typed to become `BlockRef[]` then.
- Click elsewhere, Esc, starting an edit, or starting any frontier task clears selection.
- If a `consolidation.applied` or `snippet.deleted` event removes the selected/peeked block, the
  refs are cleared (never left dangling) and the toolbar closes.

### 7.3 Revision cycling / rollback

The cycler in the selection toolbar: `◀ rev 3/3 ▶`.

- First interaction fetches `qk.revisions(snippetId)` (full texts — snippets are small).
- Stepping back sets `peekRevision` and the block renders that revision's text with a thin
  "viewing rev 2 of 3 — [Restore] [Latest]" banner. Peeking is purely visual; nothing is written.
- **Restore** calls `POST …/restore { rev: 2 }` → the server appends a *new* revision whose text
  is rev 2 (history is never rewritten), optimistic-updated locally. Alt+←/→ cycles from the
  keyboard (§12).
- Sections: no cycling in MVP (no per-section history behind the frontier; 02 §6.5).

### 7.4 Provenance viewer (agent-run display)

Route `/w/:workId/runs/:runId`, a wide modal. It renders one agent run (parsed `RunEvent[]` from
`GET /runs/:r`, schema in 05 §7) as a **vertical timeline**, not a raw transcript:

```
┌ Run 01J2P7Q4 · continue · high model (…) · 6,412 in / 388 out · 13.2 s ─────┐
│ ▸ Prompt (8 regions, 6.4k tokens)          [collapsed by default]           │
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
- **Prompt region breakdown** binds to the run `meta` event's `contextSnapshot`
  (`ContextSnapshot`, §4.5): `regions` gives the per-region token counts, `items` the per-item
  fidelities and sources. Region names follow the canonical prompt region order (07-prompting).
  Expanding a region shows its items; expanding the corresponding `message` event shows the raw
  text — the user can see exactly what the model saw, one click deep.
- Tool calls render as timeline steps with human labels (from `toolCall` events); expanding a
  step shows raw input/output.
- Artifacts link back into the document (scroll-to + flash the block).
- Entry points: provenance chip on selection; each revision row in the cycler; "how was this
  written?" in the streaming block's ⋯ menu after completion.

---

## 8. Frontier controls & streaming

### 8.1 The frontier bar

The last block in the scroll surface (in-flow, so it reads as "the next thing after the text"):

```
[ ＋ snippet ]        [ Continue  ⌃⏎ ]        [ ✎ Instruct… ────────────── ⌃⏎ ]
```

- **＋ snippet** — creates an empty snippet and opens it directly in the editor. Creation is
  **not** optimistic: one localhost round-trip is imperceptible, and it removes the temp-id vs
  SSE-echo reconciliation problem entirely (the block appears when the `POST` returns; the SSE
  echo dedupes on the real id). Optimism is reserved for edits, where the id already exists.
- **Continue** — launches a `continue` task. Also triggered by **Ctrl-Enter when nothing is
  selected and no editor is open** (the brief's gesture: "ctrl-enter should do this when nothing
  is selected").
- **Instruct…** — an input that expands into a 3-row textarea on focus; Ctrl-Enter launches
  `instructed-continue`.
- The three task buttons disable while the **interactive** slot is occupied (the server answers
  409 `busy` — there is no interactive queue); a small inline "already writing — cancel &
  restart?" affordance mirrors the error surface. Background tasks never disable anything.
- If config is missing (`409 config_missing` on task create, or `setup.*` flags already known
  from `GET /api/config`), the buttons render enabled but produce a blocking callout linking to
  `/settings` (§11) instead of a bare error toast.

### 8.2 Instruction styling (never looks like story text)

Everywhere the user types *instructions* (instruct-continue box, quick-edit box, edit-task pane,
situation pane), the surface is visually distinct from prose: UI sans-serif font (body prose is
serif), amber-tinted background (`--instr-bg`), a small ✎ glyph and an "instruction" microlabel,
left-aligned ragged text. Prose surfaces are serif on paper-white. This one consistent contrast
carries the whole "am I writing story or steering the agent?" distinction — matching the prompt
side, where user instructions are always delineated as instructions, never prose (07-prompting).

Instruct-continue: the instruction text stays visible in the streaming block header
("↳ *make the storm arrive early*") and is recorded in the run (visible later in provenance).

### 8.3 Streaming display

Two rendering modes, keyed by the delta `target`:

**Frontier prose (continue / instructed-continue).** On `task.started` (interactive lane,
frontier target), a `StreamingBlock` appears above the frontier bar:

- **Planning stage** (`task.stage: planning`): a compact activity line cycling the `task.tool`
  notes ("planning — opened Chapter 7…"), with a cancel ✕. No fake prose.
- **Writing stage:** deltas for the new-snippet target append into the block with a blinking
  caret glyph; the block is styled like an agent snippet but slightly translucent until
  committed.
- Delta handling: `task.delta` events accumulate in a ref; a 33 ms rAF-aligned flush writes to
  state (≈30 fps, keeps React commits off the token firehose). A `task.snapshot` on reconnect
  replaces the buffer wholesale before live deltas resume.
- With `followBottom` the view tracks growth; otherwise a "↓ writing…" pill floats bottom-right.
- On `task.completed`, the `snippet.created` event swaps the streaming block for the real
  snippet (keyed swap, no flicker).

**Targeted rewrites (quick-edit; edit-task in M2).** Deltas for snippet/section targets are
**buffered but not rendered** in MVP: the target block shows a "being rewritten" shimmer overlay
with the planning/writing stage caption, and the committed text swaps in atomically on the
`snippet.revised` / `section.changed` event. (`task.delta` carries `target` on the wire so
inline streaming can be added later without a contract change; the buffer also feeds the
keep-partial surface below.) Watching a paragraph rewrite itself token-by-token mid-document was
rejected for MVP: it fights scroll anchoring and reads as flicker at 65ch.

### 8.4 Keep-partial and conflicts (proposal routes)

On `task.failed` / `task.cancelled` with non-null `partialText`, the streaming block (or, for a
targeted edit, an inline card at the target) shows the partial text with
**[Keep] [Discard]**:

- **Keep** calls `POST /works/:w/tasks/:t/proposal/apply`. The server reconstructs the proposal
  from the run JSONL (durable — survives restarts and lunch breaks; no TTL) and commits it with
  `authorship: "agent"` and `originRunId` set, so provenance is preserved for exactly the
  passages most likely to need it. The result arrives as a normal `snippet.created` /
  `snippet.revised` event.
- **Discard** calls `…/proposal/discard`.
- The client-side delta buffer is only a **display fallback** while the SSE stream is dead — it
  is never a commit source. After a reconnect/resync, `GET /tasks/:t` carries `partialText` so
  the choice can be re-offered (after a server restart, where the task list is gone, the same
  information comes from the durable run record via `GET /runs/:r`).

The same routes resolve the **concurrent-edit conflict**: if the user edited a target while an
edit ran, the run completes with the artifact in `conflict` state (05 §5.6) and the UI offers
"Text changed while editing — [Apply anyway] [Discard]" wired to the same apply/discard routes.
M1 renders this as a plain inline notice with the rewritten text copyable; the richer diff-style
conflict card is M2 polish.

---

## 9. Panes and panels

Layout grid (all widths persisted):

```
┌───────────┬──────────────────────────────┬───────────────┐
│ Situation │        Document view         │  Edit task    │  + WorldPanel as an
│ (left,    │        (center, own          │  (right, M2,  │    overlay sheet from
│  optional)│         scroll)              │   optional)   │    the right (routed)
└───────────┴──────────────────────────────┴───────────────┘
```

### 9.1 Situation pane (left)

- Toggle: header button or `Ctrl+;`. Width 320 px default, drag-resizable 240–480.
- **Own scroll container**, independent of the document.
- One markdown textarea (instruction styling, §8.2), always editable — no edit mode; it's a
  scratchpad. Saves via `PUT /situation { text, baseHash }`, debounced **1,000 ms** after
  idle plus on blur; a subtle "saved" tick confirms.
- **Concurrency:** `baseHash` is the content hash the pane last loaded. A 409 (the file
  changed externally — e.g. the reconciler adopted an Obsidian edit) surfaces the standard
  theirs/mine prompt; "mine" resubmits with the fresh timestamp. An incoming
  `situation.changed` while the pane is dirty shows a "changed on disk — review" chip instead of
  silently ignoring or clobbering; while clean it just applies.
- **Easy copy from main text:** selecting a text range in the document view raises a mini
  floating button "＋ Situation" (next to the native selection); clicking appends the selection
  to the pane as a markdown blockquote with a `— Ch. 9` attribution line. Plain
  select-copy-paste also works everywhere (no `user-select` games anywhere in the doc view).

### 9.2 Edit-task pane (right) — ships M2

For deliberate, targeted edits (bigger than quick-edit). Toggle: `Ctrl+'` or "Edit task…" in the
selection toolbar (which pre-fills the target). Specified here in full so M2 is a wiring
exercise:

1. **Instructions** — multi-line textarea, instruction styling.
2. **Target** — the selected block(s), shown as removable chips ("Ch. 9 · ¶ 4–6",
   "snippet a1"). Multi-select (shift-click range) lands together with the pane. Empty target =
   frontier (the task becomes an instructed continue with edit framing — the pane says so).
3. **Context pickers** — two collapsible checklists fed by `GET /context/candidates`
   (06 §9.2): the section tree and the world-entry list, each row showing name +
   per-fidelity token counts, with a fidelity dropdown (`short/long/full`) on checked rows.
   Rows already elevated by the engine's ledger come pre-checked (from `currentFidelity`).
   Candidate rows carry `{ id, kind, … }` — bare ULIDs plus an explicit kind field.
4. **Token meter** — a horizontal bar: assembled estimate vs the effective soft budget and hard
   cap, with the numbers printed. Fed by `POST /context/preview` (returns totals, per-region
   breakdown, the effective `softBudget`/`hardCap` numbers, and `overSoft`/`overHard` flags —
   settled in 03 §3.11/06: the client renders no budget constants of its own), debounced
   **300 ms** after any change; turns amber past soft, red past hard-cap territory, and disables
   launch with the engine's structured message ("Selection exceeds the context limit…",
   06 §8.2). A pre-launch summary line comes from `POST /tasks/estimate` (adds cost math),
   rendered with "~". All numbers are server-computed; the meter renders what it is given.
5. **[Run edit task]** (Ctrl-Enter within the pane) — posts a `TaskSpec` of kind `edit-task`
   with `targets`, `pinnedWorldEntryIds`, and `contextSelections: [{ id, kind, fidelity }]`
   (05 §2.1).

Progress: targets shimmer per §8.3; results arrive as revisions/section changes via SSE and
flash-highlight on arrival.

### 9.3 World panel

Routed overlay sheet from the right (560 px, over the edit-task pane if open), `Ctrl+.` or the
"World" header button.

- **List view** (`/world`): search-as-you-type filter (client-side over the loaded list),
  rows = 40 px thumbnail (or a glyph), name, key count, one-line summary. "＋ New entry."
- **Entry view** (`/world/:entryId`):
  - name (inline-editable), **keys** as a chip editor (add/remove strings; zero keys is valid),
  - **image**: displayed 320 px wide; buttons *Generate* / *Regenerate* (launches a
    `world-image` task; progress via `task.progress` phases on the shimmer overlay) and
    *Remove*; manual upload accepts an image file (raw PNG body per 03 §3.5),
  - `shortSummary` one-line field,
  - **body**: always-editable markdown textarea with a rendered-preview toggle (entries are
    working documents, not prose). Ctrl-Enter saves, Esc reverts; same 409-on-stale handling as
    sections.
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
  from the section id hash) so cards stay scannable. User-suppressed illustrations (deleted via
  the ⋯ menu) also render the placeholder, with no staleness badge and no auto-regeneration —
  "Generate" in the menu re-enables (08 §5).
- **States:** `stale.illustration` → tiny ⟳ badge with tooltip "outdated — regenerate" (menu
  action); generation in progress → shimmer overlay on the reserved box with the
  `task.progress` phase caption ("Composing prompt → Generating (attempt 2/3, 64 %) →
  Critiquing…"); failed → placeholder + retry in the ⋯ menu, detail from the `pipeline` error.
- Click → lightbox (full resolution, section title, [Regenerate] [Close]).
- `src = /api/works/:w/sections/:s/illustration?v=<illustration.version>` — the version is the
  PNG's content hash, so both content-driven regenerations and same-content re-rolls bust the
  cache exactly; `enrichment.updated` delivers the new version inline.
- Every `<img>` sits in an `aspect-ratio` reserved box (dimensions in `SectionRow.illustration`),
  so loads never shift layout (§5.5).

---

## 11. First-run and settings

The `/settings` route is a friendly editor over the server's config file (03 §9) — not a
separate store:

- **First-run:** when `GET /api/config` reports `setup.highConfigured === false`, the app routes
  to `/settings` in a welcome layout: three cards — **High model**, **Low model**, **ComfyUI**
  (the third skippable) — each with baseUrl / apiKey / model fields and a **Test** button that
  hits `POST /api/config/test` with the unsaved candidate (results render inline: ok / auth /
  unreachable / timeout). Save → `PUT /api/config` → into the works list. API keys display as
  "set/not set" (the server redacts); leaving the field blank keeps the existing key.
- **Later visits:** the same three cards, plus "Reload from disk" (`POST /api/config/reload`)
  for hand-editors, and the `restartRequired` list from `PUT` rendered as a "restart Cowrite to
  apply" notice.
- Every `409 config_missing` surface in the app (task buttons, generate-image buttons) links
  here. Browsing, reading, and hand-writing snippets work fully with zero endpoints configured.
- Fold defaults, budgets, and consolidation thresholds have **no UI** in MVP — they live in
  config files / `work.json` per the brief's "fiddly knobs live in config files" principle.

---

## 12. Keyboard model

One resolver (`keyboard.ts`) dispatches by context, most-specific first; contexts are: editor
open → instruction input focused → selection active → global. All bindings shown in a `?`-key
cheat sheet.

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
| | `Ctrl+;` / `Ctrl+'` / `Ctrl+.` | toggle situation / edit-task (M2) / world panel |
| | `Esc` | close topmost surface (modal → panel → nothing) |
| | `?` | shortcut cheat sheet |

Deliberately absent in MVP: vim-style navigation, Ctrl-K command palette (structured for —
`keyboard.ts` is a table — but resist), custom rebinding.

---

## 13. Snappiness tactics

| Tactic | Where | Number |
|---|---|---|
| Optimistic cache writes with rollback | snippet save/delete/restore, world edits (never create — §8.1) | perceived 0 ms |
| SSE echo-dedupe | reducer skips events whose `(id, rev)` already in cache | no double flash |
| Debounced saves | situation 1,000 ms; edit-task preview 300 ms; draft crash-copy 500 ms | |
| Prefetch | section text on header hover (150 ms); world list on work open; revisions on toolbar mount | |
| rAF-batched stream flush | task deltas | ~30 fps commits |
| Virtualization | 15–25 mounted blocks regardless of work size | |
| Memoized markdown+decorations | keyed on `(rev\|contentHash, worldVersion)` | re-render of one block never re-parses others |
| Store selector subscriptions | blocks subscribe to `selection?.id === myId`, not the store | selection change re-renders 2 blocks |
| Reserved image boxes | `aspect-ratio` everywhere | zero CLS |
| Single SSE connection | per open work | no polling |

Startup: `GET /works/:w` + sections + snippets + world fire in parallel from route loaders;
the document renders on sections+snippets (world decorations pop in a beat later if slower).

---

## 14. Failure modes

| Failure | Behavior |
|---|---|
| Unconfigured endpoints (fresh install) | first-run routes to `/settings` (§11); any later `409 config_missing` → blocking callout on the control, linking to settings — never a bare error toast |
| SSE drops | backoff reconnect (0.5→8 s) with `Last-Event-ID`; `resync` → invalidate all work queries; >10 s down → thin offline banner |
| Server restarted mid-task | heartbeat loss ends the stream; streaming block shows buffered text + "connection lost"; on reconnect, task state re-derived from `GET /works/:w/runs/:r` for the watched task (run records are durable; `GET /tasks[/:t]` is in-memory and empty/404 after a restart — never polled for recovery), and keep/discard resolves via the proposal apply/discard routes (§8.4) — the run file is the durable source, so nothing expires |
| 409 on save (stale rev/hash) | rollback optimistic write, reload, keep draft open, toast |
| External-edit conflict | server-driven theirs/mine choice surfaces as a modal (02 §8); "mine" resubmits with a fresh `baseHash`; applies to sections, world bodies, and the situation pane alike |
| Consolidation touches UI-referenced snippets | editor-open snippets are excluded server-side via the editing signal (§7.1); selection/peek refs to consumed ids are cleared by the reducer; orphaned crash-copy drafts surface once as recoverable text, then GC (§4.1) |
| Undo grace expired | undo route returns 409 `conflict` → toast "Undo window has passed"; the toast also auto-dismisses at the grace deadline |
| Edit conflict (agent run vs user edit) | inline apply-anyway/discard via proposal routes (§8.4) |
| Task failure | toast with run error (+ retry when `retryable`); provenance viewer link for the full story; background failures stay quiet (badge + activity popover) |
| Illustration 404/failed | placeholder + retry menu; `pipeline` error detail as badge tooltip |
| Zod parse failure on a response | dev: throw loudly; prod: toast "client/server version mismatch — reload" |
| Read-only mode (second instance) | `readonly.changed` banner; all mutating controls disabled, viewing/scrolling fully functional |
| Very long single section (>20k words) at `full` | render the first 20k words + a "Show all" expander that renders the remainder non-virtualized (accepted jank; consolidation keeps sections chapter-sized, so this is a rare escape hatch, not a polished path) |

---

## 15. Testing

### 15.1 Unit / component (Vitest + Testing Library, jsdom)

Pure modules first — they carry the tricky logic: `foldPolicy` (table-driven distance→level +
override + degradation), `dialogue` (quote pairing incl. unclosed/curly), `worldMatcher`
(boundaries, overlaps, case, multi-word keys, all-occurrences-per-block), `anchoring` (simulated height
mutations preserve anchor math), `useDocBlocks` (tree+snippets→blocks snapshots), SSE reducer
(each event row of §4.3 as a test case against a seeded QueryClient + stores — including
lane routing: a background `task.started` mid-interactive-stream must not touch the slot).
Component tests: editor key handling (incl. editing-signal calls), revision cycler, selection
toolbar.

### 15.2 Playwright e2e

Lives in `apps/web/e2e`; runs against the **real server** with mock OpenAI/ComfyUI endpoints
(09-testing owns the mocks) and a temp data dir per test file.

```ts
// playwright.config.ts (essentials) — no shell-isms; runs unmodified on Windows
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "cowrite-e2e-"));
export default defineConfig({
  webServer: {
    command: "pnpm --filter @cowrite/server start",
    env: { COWRITE_DATA_DIR: dataDir, COWRITE_MOCK_LLM: "1", COWRITE_PORT: "2697" },
    url: "http://127.0.0.1:2697/api/health",
  },
  projects: [{ name: "chromium", use: devices["Desktop Chrome"] }], // localhost app: one browser in CI
});
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
   exists with rev-1 text; provenance chip opens run viewer showing the mock prompt regions
   (from `contextSnapshot`).
3. **fold-ladder** — open `novel` fixture; assert the ladder (2 full / 4 long / 8 short / rest
   name) via testids; pin a `name` chapter to `full`; assert lazy content request fired and
   scroll position of the pinned header is preserved (±2 px) after expansion; reload → pin
   persisted.
4. **anchoring-under-load** — scroll to mid-document, trigger consolidation via API, assert
   viewport anchor block unchanged.
5. **instruct-and-quick-edit** — instruct-continue with instruction visible in stream header;
   select a snippet → quick edit → target shimmers (no mid-document token rendering) → new
   revision arrives and swaps atomically.
6. **world-flow** — create entry with key "storm glass" → underline appears in visible prose →
   hovercard shows summary → click navigates to entry → generate image (mock ComfyUI, phase
   captions assert) → thumbnail appears.
7. **edit-task-meter** *(M2, lands with the pane)* — open pane, check sections until the meter
   passes soft budget (amber), assert number matches `POST /context/preview` response; launch
   and assert selections recorded (via `/context/state`).
8. **resilience** — kill/restart server mid-stream via control endpoint; assert keep/discard
   surfaces after reconnect and **Keep** commits with agent authorship (assert provenance chip
   on the resulting snippet).
9. **background-during-stream** — start a Continue; mid-stream, trigger consolidation so an
   `enrich-section` task starts; assert the streaming block keeps rendering continue prose,
   buttons stay in their continue state, and the background badge appears. (Regression fence
   for the task-store lane routing.)
10. **consolidation-under-edit** — open an editor on an old eligible frontier snippet; trigger
    consolidation via API; assert the edited snippet survives in the frontier (editing signal
    honored) while earlier snippets froze; save succeeds.

Selectors: `data-testid` constants from `src/testids.ts` only — shared import, so renames break
compile, not CI. Waits: always on visible state (`toHaveText`, `toBeVisible`), never timeouts.

---

## 16. MVP cut

**M1 (the product — matches the project-wide milestone plan in 10-roadmap):**

- Works list; first-run setup + settings screen; `config_missing` callouts
- Work view: single virtualized doc with fold ladder + pins + anchoring + lazy section text;
  followBottom / jump-to-frontier
- Snippet create/edit (dbl-click, Ctrl-Enter/Esc) with the editing signal, select, delete,
  revision cycle + restore
- Continue / instructed-continue / quick-edit (one frontier snippet) with streaming display,
  cancel, keep-partial via proposal apply; targeted-edit shimmer; basic conflict notice
- Background-task display: enrichment badges, illustration progress phases, activity popover
- Provenance viewer (basic timeline: header, region breakdown from `ContextSnapshot`, tool
  steps, output, artifacts)
- Situation pane with copy-from-selection and theirs/mine conflict handling
- World panel: list, entry edit, keys, image display + generate/upload/remove
- Rendering: markdown, dialogue tint, world-key underlines + hovercards, provenance edge tints,
  staleness badges, consolidation undo toast + undo route, read-only banner
- Illustrations right-of-text / inline cards, lightbox, regenerate, suppressed handling
- Keyboard model of §12; light/dark theme; e2e specs 1–6 and 8–10

**M2:**

- Edit-task pane (§9.2): instructions, target chips, candidate pickers, live token meter
  (`/context/preview`), pre-launch estimate (`/tasks/estimate`), `contextSelections` on task
  submit
- Quick-edit/edit-task on frozen-section paragraph spans; multi-select targets
  (`selection: BlockRef[]`)
- Conflict-card UI polish (diff-style card replacing the M1 inline notice)
- Consolidation review-mode UI (auto+undo ships in M1)
- Playwright spec 7

**Structured-for, deferred beyond M2:**

- Frozen-section provenance history view (`history.jsonl` timeline) and behind-frontier
  revision UI; un-freeze section action
- Ctrl-K palette over server FTS5; per-speaker dialogue coloring; cheat-sheet search
- Mobile/narrow layout (panes become sheets); settings UI for fold defaults and budgets
  (config files only until then)

---

## 17. Contracts

Shared schemas this subsystem **consumes** (all from `packages/shared`, imported as TS source):

| Schema(s) | Module | Defined in |
|---|---|---|
| `WorkEvent` (SSE union; `task.started` carries `lane`; `task.delta` carries `target`; `task.progress` carries the illustration phase enum + `pct`) | `events.ts` | 03 §8.2 (canonical presentation) |
| `WorkSummary`, `WorkDetail`, `SectionRow`, `SnippetDto`, `RevisionEvent`, `WorldEntryDto`, `SituationDto` | `work.ts`, `section.ts`, `snippet.ts`, `world.ts`, `situation.ts` | 02 (storage shapes), 03 §3 (DTO wrapping; summaries inlined, `revisionCount`, `illustration {version,width,height}`) |
| `TaskKind` (kebab-case), `TaskSpec` (incl. `contextSelections` on `edit-task`), `Task`, `RunEvent`, `RunArtifact`, `ContextSnapshot`, `TaskEstimate` | `tasks.ts`, `runs.ts` | 05 §2, §7 |
| `Fidelity`, candidate/preview DTOs (`/context/candidates`; `/context/preview` responses carry the effective `softBudget`/`hardCap` — settled, 03 §3.11 / 06) | `context.ts` | 06 §9–10 |
| `ErrorCode`, `ApiErrorBody` | `api.ts` | 03 §7 |
| `PublicConfig`, `ConfigUpdate`, `ProbeResult` | `config.ts` | 03 §9 |
| `Ulid`, `OrderKey`, `IsoTime`, `Hash` | `ids.ts` | 02 §3 |

Routes this subsystem depends on beyond plain CRUD: `POST /works/:w/editing` (03 §3;
consolidation exclusion, 02 §6.2), `POST /works/:w/consolidations/:undoToken/undo` (03 §3),
`POST /works/:w/tasks/:t/proposal/apply|discard` (03 §3.7, 05 §8), SSE resume + `task.snapshot`
reconnect semantics (03 §8.3).

Schemas/values this subsystem **owns** (frontend-local, not shared): `FOLD_DEFAULTS` and the
fold policy (§5.3), the `testids.ts` constants, all Zustand store shapes, and the `FoldLevel`
type alias of `Fidelity`. Prompt region names rendered in the provenance viewer follow the
canonical region grammar owned by 07-prompting; this doc renders whatever region names the
`ContextSnapshot` reports and never hardcodes the list.

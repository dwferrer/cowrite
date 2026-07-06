# Product Brief: Illustrated Cowriter (working name; repo: "cowrite")

This is the founder's brief, verbatim. Treat every requirement here as authoritative unless it is
physically contradictory; where the brief grants discretion, it says so explicitly.

---

I want to build an app like a simple, modern version of Silly Tavern, stripped of all its old-school
fiddly features and its over-broad range of services to target. This should be a combination of a
snappy web interface for the user and a powerful agent harness on the back-end.

# Illustrated Cowriter (it's not a snappy name; we can workshop that)

The user co-writes a story with an LLM assistant. An image-gen model illustrates the scenes as they
are written. That is the simple, top-level concept. What differentiates this from what currently
exists is the focus on modern agentic features, large contexts, and simplicity for the user.

## What we are writing

We want to be able to write long running, novel-length text (presumably fiction). This should mostly
be written in short snippets, either by the user or the LLM. The primary pattern will be appending to
the story, but we should support editing arbitrary passages. The main features will just be targeted
at this serial workflow.

Let's call the current furthest location in text, the primary active worksite, the **frontier**. We
assume most work is being done at the frontier.

Since this is a novel-length work, we need to be able to navigate it more efficiently than an
infinite-scroll chat log. I see something like the following hierarchy of texts:

+ Work: All text that should be grouped together into a single session
+ Section: Nested, mostly static divisions of prior-written text. These make sense for text
  relatively far from the frontier. We don't want to put a lot of work into precisely dividing and
  **enriching** (our term of art for like adding navigation markers and summaries) text that is
  actively being worked on. There's no point summarizing a chapter until the chapter has been
  finished. "Section" is a category; there may be several different, nestable levels within it,
  e.g., book, part, arc, chapter, scene, etc. We shouldn't be too precious about the precise
  definitions of these. They don't have to be fully user configurable, but it should be easy to
  change them on the back-end. Let's assume these are *always* nested. The inclusion relation makes
  a tree. In addition to text, these can be **enriched** with:
  - Summaries, at different levels of detail, at least *short* and *long*. These are for the LLM,
    but should also be legible to the user. The user should also be able to edit these as they
    please. To keep us grounded, let's assume that the earlier context together with the target
    section always contains the full information content of the summary, and, similarly, small
    summaries of a section are always derivable from larger ones. A summary should thus always be
    able to be freely substituted with the source text (given the preceding context) without losing
    information.
  - Illustrations: Images tied to a given section. For our sanity, let's assume there can be only
    one image per section. If we want more images, we need to tie those to a lower-level of
    sectioning. For now, I think this is plenty of granularity. It starts to get clunky if we have a
    section for every sentence, but I'm imagining an image should usually cover at least a few
    paragraphs.
  - A name: The visible, human readable name of the section. Obviously this should only be for
    longer sections. Every scene doesn't get a name. At the same time, we should try to make
    higher-level sections have names, leaning on the model to do that if necessary. It helps
    navigation.
  - All of these fields are optional
+ Snippet: I'd also consider "passage" for this. The base unit in which the user / LLM add to the
  story. These only make sense near the frontier. The app should automatically transition from a
  "snippet" representation near the frontier to a "section" representation further away. It's fine
  if this results in losing the precise edit history once the frontier is far enough away. The focus
  for snippets is on the precise authorship and creation history of text, rather than navigation. We
  should be able to easily distinguish user written / edited text from model written / edited text,
  and changes should be easy to cycle between and roll back. Once these have frozen into sections,
  this history is not important to surface. I leave it open whether the back-end should continue to
  track it, or if we should collapse it fully. I lean toward the latter, except that this makes
  interesting challenges for if the user decides to go back and edit. Then again, we're assuming
  that's not a common case, so it's fine if it merely works, rather than feeling great.

## The back end

Let's assume that the user has access to the following, with only minimal allowances for other
approaches:
+ An LLM, cloud or local, accessible through an OpenAI-compatible API. We should assume a "low" and
  a "high" model, though these may be the same. The "high" model is used for writing and
  heavy-weight agentic tasks. Assume something big and powerful like GLM-5 (though no specific model
  is targeted). The "low" model is used for basic agent work like short summaries or image
  generation. Assume a small VLM like Gemma 4 31B.
  - The low model needs to be a VLM for agentic image-gen. It should be fast and cheap, bad at
    writing quality prose, but good at following basic instructions.
  - The high model is not a VLM (unless it is the same as the "low" model). We do not send images to
    the "high" model, only text.
+ A ComfyUI instance, again cloud or local, accessible through its API. Let's leave the precise
  workflow specifications to the user. A given workflow is assumed to take a prompt and return an
  image.
  - Any fiddly bits like samplers, loras, noise schedules, etc. are assumed to be handled on the
    ComfyUI side.
  - We may have different workflows for different types of illustration or quality-level. For
    instance, portraits, scenes, high-quality models with upscaling we only use sparingly, etc. It's
    fine if we leave this out of the MVP, but let's at least build room for it.
  - For now, let's target only modern image-gen models that take natural language, descriptive
    prompts. No lists of tags, no negative prompt, no feature-specific prompting, etc.
  - We should aim to improve image quality primarily through *agentic feedback*, not workflow
    complexity. For now, let's have a simple worker that uses the "low" model (the VLM) to write the
    prompt and make edits based on the result. We can assume the image gen itself is cheap, taking
    < 20 seconds per image. Again, post MVP we can envision making a more robust agentic process
    here that exposes more knobs from the ComfyUI workflow (region-specific edits, etc.) but for now
    let's keep it simple
+ Large amounts of local storage. All files / artefacts should be stored in the local file-system,
  grouped by work. It's fine if this results in duplication. The storage format should be
  human-readable (or at least editable with external tooling), robust, and fast.

These are assumed to be externally managed by the user. They simply provide endpoints and
credentials.

The back-end runs as a console app like SillyTavern, accessible by pointing a browser at localhost.
We do not need authentication or multi-tenancy. The particular language is up to you, but it should
be modern and easy to deploy on both linux and windows.

## The Co-writing Experience

The presentation should be similar to a modern IDE or word processor. Clean, snappy, responsive, and
easy to read. Let's support rich markdown for display, rendering it whenever the user isn't editing
a particular snippet (where it should be presented as plaintext).

There should be a few key interface elements:
+ The current text: At the bottom, this should be formatted *somewhat* like a chat interface, with
  separate blocks for each snippet of text.
  - Double-clicking into these makes them editable, dropping the display for that block to plain
    text, and presenting cancel / save to go back to the display mode. The editor should be easy to
    use for multi-line text---pressing "enter" should not close it. It should just add a new line.
    We save on ctrl-enter.
  - A single click selects a snippet / section. This presents us with widgets for seeing the edit
    history / sourcing for the text. I'm not sure about the best way to display this for more
    agentic workflows, but I'd like to be able to see the particular prompt / process that gave rise
    to a particular version of a snippet.
  - When snippets are selected (but none are being edited; opening a snippet for editing removes
    selection), we have the option to give an "edit task" to the model. This should start as a
    simple box for short instructions, with the opportunity to expand to a detailed pane (the "edit
    task" flow below). This mode of asking for edits is intended to be simple for quick requests.
    Anything long or complex should be handled through the "Edit Task" flow
  - Scrolling back should start to progressively collapse the detail initially shown of the text.
    First, we decay from separate snippets to sections, keeping the full text. Then, we should start
    collapsing the hierarchy, showing long summaries of e.g. the previous couple chapters, then
    short summaries, then finally only names / illustrations.
  - When rendered as section text, we should give the text rich but subtle coloring to indicate
    things like dialogue. When not selected, a snippet near the frontier should also display this
    way. When selected, the coloring should change to indicate provenance.
+ Illustrations: In the main view, we should be able to see the illustrations for the text. Whenever
  we present the full text of a section, this should be to the right of it, but at the highest
  levels of folding where only a section name is shown, the image should be shown inline
+ At the frontier, there should be a button that adds a new, editable empty element. This is for the
  user to start writing a new snippet.
+ Beside it, there should be a button to have the model continue the story, generating a new
  snippet. This should aim to add roughly a "page" of new text (this is what we prompt the model for
  and set limits around, but the exact amount is at its discretion). ctrl-enter should do this when
  nothing is selected
+ Next to this button should be the "instruct" variant of continuation, where we give the user a box
  where they can write simple instructions for what should happen in the next snippet. This should
  be clearly distinguished from starting a new snippet. The user instructions should be clearly
  delineated in the resulting prompts as *instructions* not text.
+ To the left of the main text, there should be an optionally displayed "situation" element, where
  the user can write a basic outline / instructions for the current scene. This scrolls separately
  from the main text--it should be easy to copy from the main text into it. The prompt should again
  clearly differentiate this from the main body of the text.

### Edit Tasks

"Edit Tasks" (not a name I'm in love with) are requests to an agent to edit a piece of the work.
They have a dedicated modality for launching them (as opposed to the quick version mentioned above).
This gives us a view where we can give detailed instructions and select particular sections and
world-info entries, showing things like the amount of context tokens this will take (this doesn't
have to be exact).

### Context

In addition to its main text, a "work" should be associated with a world-info / context that
contains information about the characters / concepts / setting / etc. that is not written in the
voice of the text. We should be able to edit this in a separate view.

Context entries have:
+ A name / title: obvious what this is.
+ Keys: Different ways to refer to this in the main text. None of these need to be given, but if
  they are any matches in the main text should be *subtly* indicated. Something like a slightly
  bolder font, or a minor color shift. Hovering on them should show a small version of the entry
  (its summary and image if present; if no summary, the first few lines of the text). We should be
  able to use this to quickly open the context panel and immediately navigate to the corresponding
  entry.
  - We **do not** use keys for choosing what context to send to the model at present. We are
    assuming these are big models where we don't have to be judicious with context, and we have a
    richer way of selecting context anyway.
+ Text content: Markdown body of the entry. Rendered when not being edited. These are put directly
  into the prompt when used, properly formatted.
+ An image: again, obvious. this doesn't *go* anywhere for now. It's just for the user. But we
  should be able to easily generate one for them, or let them add manually. In the future, we might
  do something more interesting with these in the illustration workflow.
+ A summary: Only a short one. We shouldn't have single entries long enough to require multiple
  levels of summary.

## Prompting

Everything submitted to the model should use a robust markup format (yes, we're blending markup and
markdown; this works great IME), with clear sections and hierarchy. Primary instructions go at the
top, the most recent text at the bottom. We want to be cache-friendly whenever possible.

But this is not a simple one-and-done prompt template. We are doing full agentic editing, even for
small tasks. This is obviously pretty expensive, so a major novel (hah) feature we are aiming here
for is **smart context management**. When the user submits a task, we give the model the current
context state, which includes hierarchical summaries ranging all the way up to the top level of the
text. During the planning stage, the model can use tool-calls to request more details about
particular pieces of context or simply continue to write. At the end, we assess what was cited,
decaying open items back to summaries after several actions.

To keep costs down, we need to try to avoid too much churn in this. We'll need to do profiling to
refine the exact way this will function. But we should have some sort of progressive penalty for
including more context that kicks in well before the actual total context size. Exceeding this
"soft" budget should be allowed, but accelerate dropping of older items. You have broad discretion
in how this should actually work.

What I *don't* want to include yet is a full RAG system, vector search, etc. We may bring those in
some form later, but for now I want to avoid the traditional approach. With SillyTavern, I've found
myself either manually selecting world info to include or just including it all. Vector search is
probably best-in-class for finding something like previous events to call-back to in a long corpus,
but not great for grabbing precise info.

We can spend plenty of time perfecting prompts and workflows after we have the initial version to
play with. Just keep it in mind.

### Prompt structure

One critical thing to watch for here is that we need to keep a consistent style and voice throughout
the work. A lot of our prompt will not be in that voice---the world-info, instructions, situation,
etc. will generally be in a very different style than the novel prose. Unless we want everything to
be in the default voice of the LLM, this usually takes two things:

1. Having enough recent prose in context. This is relatively simple, if unpleasant. 10k tokens is
   usually enough, though it's best if this *isn't* just the latest writing. It's important to have
   that, but having a range of pieces from different moods throughout the work helps keep things
   dynamic
2. Proper delineation and presentation of the context prose: It needs to be *extremely* clear what
   is the real novel prose the model should be writing to, and the frontier context snippet should
   be as near the bottom of the prompt as possible during composition. With modern reasoning models
   this takes some care. Long thinking traces tend to collapse the output to a particular voice.
   We've seen gradual improvement in this, but the basic LLM pretraining task means continuing text
   at the bottom of context will always have certain advantages. In single shot prompting, I usually
   use a structure like this:

```not-xml
<instructions>
</instructions>
<world-info>
<entry>
## Blah Blah
</entry>
</world-info>
<global-context>
<snippet chapter="Prologue" lines="10:230">
lorem ipsum dolor whatever...
</snippet>
<local-context>
The last several hundred words right before where the model is supposed to start writing
</local-context>
```

If we update world-info slowly, this is also quite cache friendly.

---

## Additional constraints set by the implementing team (treat as fixed baseline)

To keep subsystem designs mutually consistent, all proposals must assume this baseline stack unless
they find a hard blocker (in which case, flag it loudly rather than silently deviating):

- TypeScript everywhere. pnpm workspace monorepo: `apps/server` (Node 22+, Fastify 5),
  `apps/web` (Vite + React 19), `packages/shared` (Zod schemas / shared types).
- Files on disk are the source of truth (human-readable: Markdown + JSON/JSONL), with an optional
  SQLite index that is always rebuildable from the files.
- Server ↔ client: REST + Server-Sent Events for streaming; no auth; binds localhost by default.
- Testing: Vitest for unit/integration, Playwright for e2e, mock OpenAI-compatible + mock ComfyUI
  servers for agent tests.
- Single console command starts everything (server serves the built web app), SillyTavern-style.
- This is a single-user hobby app: favor simplicity and snappiness over enterprise concerns, but
  keep professional code standards, strong typing, and testability.

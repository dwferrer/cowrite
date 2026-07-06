# Cowrite

Co-write novel-length stories with an LLM, illustrated as you go. A simple, modern take on the
SillyTavern idea: a snappy local web app over a powerful agent harness, built for large contexts,
agentic editing, and getting out of your way.

**Status: design phase complete; implementation starting (see [docs/10-roadmap.md](docs/10-roadmap.md)).**

## What it does (when built)

- You and the model take turns appending short passages at the **frontier** of a long work; a
  Continue button (Ctrl-Enter) streams roughly a page of new prose in your story's voice.
- Older text automatically consolidates into chapters/scenes, enriched in the background with
  names, short/long summaries, and one illustration per section — so a 300k-word work stays
  navigable and affordable to prompt against.
- Agentic tasks see hierarchical summaries of the *whole* work and expand exactly the context
  they need via tool calls, with citation-based decay and a soft token budget. No vector RAG.
- Illustrations come from your ComfyUI workflow, driven by a small VLM that writes the prompt,
  critiques the result, and retries — image quality through feedback, not knobs.
- Everything on disk is human-readable (Markdown + JSON) and rebuildable; every passage is
  traceable to the exact prompt and run that produced it.

## Requirements (user-managed endpoints)

- A "high" LLM and a "low" VLM, each behind an OpenAI-compatible API (they may be the same).
- A ComfyUI instance whose workflow takes a natural-language prompt and returns an image.
- Node.js ≥ 22 and pnpm (via `corepack enable`), on Linux or Windows.

## Development

```bash
pnpm install
pnpm dev        # Fastify server (:2697) + Vite dev server (:5173)
pnpm test       # Vitest across all packages
pnpm lint       # Biome
pnpm typecheck
pnpm build && pnpm start   # production mode: server serves the built UI at :2697
```

### Docker

```bash
# Runtime
docker build -t cowrite .
docker run -p 2697:2697 -v cowrite-data:/data -e COWRITE_HOST=0.0.0.0 cowrite

# Dev container (toolchain + Chromium for e2e; mount your checkout and ~/.cowrite)
docker build --target dev -t cowrite-dev .
docker run -it -p 2697:2697 -v "$PWD":/app -v ~/.cowrite:/root/.cowrite cowrite-dev bash
```

Model/ComfyUI endpoints are configured in `~/.cowrite/config.jsonc` (a first-run setup screen
creates it) or via `COWRITE_*` env vars — see [docs/03-api.md](docs/03-api.md).

## Design docs

| | |
| --- | --- |
| [00-overview](docs/00-overview.md) | Vision, glossary, stack rationale |
| [01-architecture](docs/01-architecture.md) | Component map, process model, invariants |
| [02-data-model](docs/02-data-model.md) | Work/section/snippet model, on-disk format, index |
| [03-api](docs/03-api.md) | REST + SSE surface, config, deployment |
| [04-frontend](docs/04-frontend.md) | Document view, editing, panes, rendering |
| [05-agents](docs/05-agents.md) | Task harness, lanes, run records, model routing |
| [06-context-engine](docs/06-context-engine.md) | Smart context management (the flagship) |
| [07-prompting](docs/07-prompting.md) | Prompt markup format, voice preservation |
| [08-illustration](docs/08-illustration.md) | ComfyUI integration, VLM feedback loop |
| [09-testing](docs/09-testing.md) | Test pyramid, mock servers, failure-mode matrix |
| [10-roadmap](docs/10-roadmap.md) | Milestones and MVP boundary |

Raw design-exploration material (parallel subsystem proposals, adversarial critiques, the
cross-subsystem coherence review, and the decisions register that reconciled them) is archived
under [docs/design-notes/](docs/design-notes/) for provenance; the numbered docs supersede it.

## License

MIT — see [LICENSE](LICENSE).

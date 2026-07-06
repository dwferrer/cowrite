# Cowrite — dev-capable container image.
#
# Two targets:
#   dev     — full toolchain (node 22, pnpm, chromium for Playwright) with sources mounted or
#             copied; intended for interactive/agentic development against real model endpoints.
#             docker build --target dev -t cowrite-dev .
#             docker run -it -p 2697:2697 -v "$PWD":/app -v cowrite-data:/data \
#               -e COWRITE_HOST=0.0.0.0 -e COWRITE_DATA_DIR=/data \
#               -e COWRITE_LLM_HIGH_BASE_URL=... -e COWRITE_LLM_HIGH_API_KEY=... \
#               -e COWRITE_LLM_LOW_BASE_URL=...  -e COWRITE_LLM_LOW_API_KEY=... \
#               -e COWRITE_COMFYUI_BASE_URL=... \
#               cowrite-dev bash
#   runtime — builds the web app and runs the server (default target).
#             docker build -t cowrite .
#             docker run -p 2697:2697 -v cowrite-data:/data -e COWRITE_HOST=0.0.0.0 cowrite

FROM node:22-bookworm AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

FROM base AS dev
# Chromium + system deps for Playwright e2e runs inside the container.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
RUN npx -y playwright@latest install --with-deps chromium
COPY . .
RUN pnpm install --frozen-lockfile
EXPOSE 2697 5173
CMD ["bash"]

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM base AS runtime
COPY --from=build /app /app
ENV COWRITE_HOST=0.0.0.0
ENV COWRITE_DATA_DIR=/data
EXPOSE 2697
CMD ["pnpm", "start"]

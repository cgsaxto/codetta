# syntax=docker/dockerfile:1

# The build. One image serves the API and the web app from one process, because that is the
# only arrangement in which a permalink unfurls with its own card — apps/api/internal/site
# substitutes a block of the app's <head>, and it can only do that for a page it is serving.
#
# It is also the source of truth for building the Go half at all. tree-sitter's Go bindings
# are cgo, so `go build` needs a C toolchain and the result is dynamically linked; keeping
# the recipe here means the one place that knows about that is a file rather than somebody's
# shell history.
#
#   docker build -t codetta .
#   docker run --rm -p 8080:8080 -e GITHUB_TOKEN=... codetta

# ---------------------------------------------------------------------------------------
# The web app. Built here rather than copied in, so `docker build .` on a clean checkout
# produces the whole thing and no step is left to be remembered.
#
# No Playwright, and no browser download: the eight link-unfurl cards are committed PNGs in
# apps/web/public, which is exactly what Phase 4 bought by pre-rendering them instead of
# drawing them per request.
# ---------------------------------------------------------------------------------------
FROM node:22-bookworm-slim AS web

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN corepack enable

WORKDIR /src

# Manifests first, on their own layer, so a change to any source file does not re-resolve the
# dependency tree. Corepack reads the pnpm version out of the root package.json.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json apps/web/
COPY packages/schema/package.json packages/schema/
RUN pnpm install --frozen-lockfile --filter @codetta/web...

COPY packages/schema packages/schema
COPY apps/web apps/web
# The gallery's eight RepoFeatures documents live outside apps/web and are bundled by the
# build. See apps/web/vite.config.ts, which aliases them.
COPY fixtures fixtures

RUN pnpm --filter @codetta/web build

# ---------------------------------------------------------------------------------------
# The service. CGO_ENABLED=1 is not optional — every tree-sitter grammar is C compiled
# through the bindings, and with cgo off the build fails rather than degrading.
#
# GOWORK=off because go.work is a developer convenience: apps/api resolves the schema module
# through the `replace` in its own go.mod, which is what keeps it buildable on its own.
# ---------------------------------------------------------------------------------------
FROM golang:1.26-bookworm AS api

ENV CGO_ENABLED=1 \
    GOWORK=off

WORKDIR /src
COPY apps/api/go.mod apps/api/go.sum apps/api/
# The replace target has to exist before the module can be resolved at all.
COPY packages/schema/go packages/schema/go

WORKDIR /src/apps/api
RUN --mount=type=cache,target=/go/pkg/mod go mod download

COPY apps/api /src/apps/api
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go build -trimpath -ldflags='-s -w' -o /out/server ./cmd/server

# ---------------------------------------------------------------------------------------
# The runtime. Debian rather than a scratch image, because a cgo binary is dynamically
# linked against glibc; chasing a fully static tree-sitter build would be a second way to
# build the same thing, and the first one to break would be the one nobody runs locally.
#
# ca-certificates is load-bearing, not hygiene: every outbound call this service makes is
# https to GitHub, and without roots they all fail at the handshake.
# ---------------------------------------------------------------------------------------
FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=api /out/server /usr/local/bin/codetta
COPY --from=web /src/apps/web/dist /srv/site

# SITE_DIR is what turns this from an API into the whole product. Empty would serve documents
# and nothing else, which is the development shape, not this one.
ENV SITE_DIR=/srv/site \
    ADDR=:8080

EXPOSE 8080

# Nothing here writes to disk and nothing needs a name. GITHUB_TOKEN is required at boot and
# is passed in at run time — it is never built into a layer.
USER nobody

# No HEALTHCHECK: it would mean installing curl for the sole purpose of calling GET /healthz,
# which every platform worth deploying to will call for itself.
ENTRYPOINT ["codetta"]

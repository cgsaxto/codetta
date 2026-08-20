# The Go half of the repo. `pnpm test` covers the TypeScript half; both have to pass.
.PHONY: api-test api-dev api-golden site-dev

# Not `go test ./...`: the repo root is not a Go module, it is a workspace. The module-path
# pattern picks up every module go.work lists, so apps/api joins this target for free.
#
# The `api-dev` target arrives with the service. Right now this is the schema package alone.
api-test:
	go test codetta.dev/...

# Fails fast without GITHUB_TOKEN. Anonymous GitHub gives 60 requests an hour, which is not
# enough for one repository, so this is a hard requirement rather than a soft upgrade.
api-dev:
	go run codetta.dev/api/cmd/server

# Re-record the parsed document the golden test compares against. The web half's equivalent
# is `pnpm fixtures:update`; both belong in the commit that justifies the change, never on
# their own.
api-golden:
	go test codetta.dev/api/internal/features -run TestGoldenDocument -update

# The production shape: one process serving both the API and the built web app. That is what
# makes a permalink unfurl with its own card — `api-dev` above serves the document alone,
# with Vite serving the app, and in that setup nothing rewrites the <head>.
site-dev:
	pnpm --filter @codetta/web build
	SITE_DIR=apps/web/dist go run codetta.dev/api/cmd/server

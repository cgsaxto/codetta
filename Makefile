# The Go half of the repo. `pnpm test` covers the TypeScript half; both have to pass.
.PHONY: api-test

# Not `go test ./...`: the repo root is not a Go module, it is a workspace. The module-path
# pattern picks up every module go.work lists, so apps/api joins this target for free.
#
# The `api-dev` target arrives with the service. Right now this is the schema package alone.
api-test:
	go test codetta.dev/...

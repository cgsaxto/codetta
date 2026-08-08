module codetta.dev/api

go 1.26

require codetta.dev/schema v0.0.0

// Workspace-local. The replace keeps this module buildable on its own, which the Dockerfile
// needs — go.work is a developer convenience, not something a build image should depend on.
replace codetta.dev/schema => ../../packages/schema/go

require (
	github.com/tree-sitter/go-tree-sitter v0.25.0
	github.com/tree-sitter/tree-sitter-go v0.25.0
	github.com/tree-sitter/tree-sitter-javascript v0.25.0
	github.com/tree-sitter/tree-sitter-python v0.25.0
	github.com/tree-sitter/tree-sitter-typescript v0.23.2
)

require github.com/mattn/go-pointer v0.0.1 // indirect

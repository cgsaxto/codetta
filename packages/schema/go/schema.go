// Package schema is the RepoFeatures contract, as Go sees it.
//
// src/index.ts is the same contract as TypeScript sees it. The roadmap originally called
// for generating both from one source; two hand-written declarations plus a test that
// proves they agree turned out to be less machinery for the same guarantee, on a contract
// this small. schema_test.go and src/conformance.test.ts are that test.
//
// Nothing music-related belongs in this file. If a field name mentions pitch, tempo,
// instrument or volume, it is in the wrong document — see docs/features-schema.md.
package schema

// SchemaVersion is bumped whenever this contract changes. Changing it means updating every
// fixture in fixtures/.
const SchemaVersion = 1

type RepoIdentity struct {
	Owner string `json:"owner"`
	Name  string `json:"name"`
	Ref   string `json:"ref"`
	// CommitSha is the full 40-char SHA: the cache key, and the source of Seed.
	CommitSha       string `json:"commitSha"`
	PrimaryLanguage string `json:"primaryLanguage"`
	Stars           int    `json:"stars"`
	FetchedAt       string `json:"fetchedAt"`
}

type Totals struct {
	FilesScanned int `json:"filesScanned"`
	// FilesSkipped counts files over cap, binary, vendored, or in an unsupported language.
	FilesSkipped int `json:"filesSkipped"`
	LinesOfCode  int `json:"linesOfCode"`
	Functions    int `json:"functions"`
	Classes      int `json:"classes"`
	Imports      int `json:"imports"`
}

type LanguageShare struct {
	Name string `json:"name"`
	// Share is 0-1.
	Share float64 `json:"share"`
	Files int     `json:"files"`
}

type RepoModule struct {
	Path string `json:"path"`
	// Share is the fraction of total LOC, 0-1.
	Share       float64 `json:"share"`
	Files       int     `json:"files"`
	LinesOfCode int     `json:"linesOfCode"`
	// AvgNestingDepth is the mean max-depth per function.
	AvgNestingDepth float64 `json:"avgNestingDepth"`
	MaxNestingDepth int     `json:"maxNestingDepth"`
	// AvgFunctionLength is measured in statements, not lines.
	AvgFunctionLength float64 `json:"avgFunctionLength"`
	// CyclomaticDensity is branch nodes / total AST nodes, 0-1.
	CyclomaticDensity float64 `json:"cyclomaticDensity"`
	// CommentRatio is comment lines / total lines, 0-1.
	CommentRatio float64 `json:"commentRatio"`
	// AsyncRatio is async or promise-returning fns / total fns, 0-1.
	AsyncRatio float64 `json:"asyncRatio"`
}

type TimelineEntry struct {
	Index        int    `json:"index"`
	ModulePath   string `json:"modulePath"`
	Path         string `json:"path"`
	LinesOfCode  int    `json:"linesOfCode"`
	Functions    int    `json:"functions"`
	MaxNesting   int    `json:"maxNesting"`
	Branches     int    `json:"branches"`
	CommentLines int    `json:"commentLines"`
}

type RepoFeatures struct {
	SchemaVersion int          `json:"schemaVersion"`
	Repo          RepoIdentity `json:"repo"`
	// Seed is the first 8 hex chars of Repo.CommitSha.
	Seed      string          `json:"seed"`
	Totals    Totals          `json:"totals"`
	Languages []LanguageShare `json:"languages"`
	// Modules holds the top 6 directories by LOC, ordered by share descending.
	Modules []RepoModule `json:"modules"`
	// Timeline is depth-first, lexicographic by path, capped at 256 entries.
	Timeline []TimelineEntry `json:"timeline"`
}

package parse

import (
	"bytes"

	ts "github.com/tree-sitter/go-tree-sitter"
)

// FileStats is everything one file contributes to RepoFeatures. Aggregation sums these; it
// never looks at a syntax tree, and it never knows which language produced them.
type FileStats struct {
	Path     string
	Language string

	// LinesOfCode counts non-blank lines, comments included — they are lines of a file.
	LinesOfCode  int
	CommentLines int

	Functions int
	Classes   int
	Imports   int
	Branches  int

	// TotalNodes is the denominator of cyclomaticDensity.
	TotalNodes int

	// MaxNesting is the deepest stack of branches anywhere in the file.
	MaxNesting int

	// Sums rather than per-function slices: the averages are all this file owes the module,
	// and a slice per file would be a lot of garbage for a 2,000-file repository.
	NestingSum     int
	StatementSum   int
	AsyncFunctions int
}

// Counter parses and counts. tree-sitter parsers are not safe to share across goroutines,
// so parallel parsing means one Counter per goroutine — which is fine, because the schema
// doc requires results to be re-sorted before aggregation anyway.
type Counter struct {
	parser *ts.Parser
	// The grammar currently loaded, so a run of same-language files does not reload it.
	current *Language
}

func NewCounter() *Counter {
	return &Counter{parser: ts.NewParser()}
}

func (c *Counter) Close() {
	c.parser.Close()
}

// Count parses one file. The second return is false when the extension is not one we
// support, which the caller reports as a skipped file rather than as an error.
func (c *Counter) Count(name string, source []byte) (FileStats, bool) {
	language, ok := ForPath(name)
	if !ok {
		return FileStats{}, false
	}

	if c.current != language {
		if err := c.parser.SetLanguage(language.Grammar()); err != nil {
			return FileStats{}, false
		}
		c.current = language
	}

	tree := c.parser.Parse(source, nil)
	if tree == nil {
		return FileStats{}, false
	}
	defer tree.Close()

	stats := FileStats{
		Path:        name,
		Language:    language.Name,
		LinesOfCode: countCodeLines(source),
	}

	// tree-sitter is error-tolerant by design: a file that does not compile still produces a
	// tree, and the counts from it are still broadly right. Refusing to count anything that
	// fails to parse cleanly would drop a lot of perfectly ordinary source.
	walk(tree.RootNode(), &language.sets, &stats, 0, nil)

	return stats, true
}

// countCodeLines counts non-blank lines. Blank-line style varies far more between projects
// than it says anything about them.
func countCodeLines(source []byte) int {
	count := 0
	for _, line := range bytes.Split(source, []byte("\n")) {
		if len(bytes.TrimSpace(line)) > 0 {
			count++
		}
	}
	return count
}

// funcAcc collects what one function contributes while its subtree is being walked.
type funcAcc struct {
	statements int
	maxNesting int
	baseDepth  int
}

func walk(node *ts.Node, sets *kindSets, stats *FileStats, depth int, fn *funcAcc) {
	kind := node.Kind()

	// Only named nodes are counted, and the reason is not tidiness.
	//
	// A keyword token carries the same kind string as the rule it belongs to: `class C {}`
	// contains a `class_declaration` and, inside it, the anonymous `class` keyword whose
	// kind is also "class". Matching kinds without this guard counted every JavaScript and
	// TypeScript class twice, and would have done the same to every Python lambda.
	//
	// Async markers are the deliberate exception — `async` *is* a keyword token — which is
	// why hasAsyncMarker does its own scan below.
	named := node.IsNamed()
	if named {
		stats.TotalNodes++

		switch {
		case sets.comments[kind]:
			// A block comment spans the rows it covers; a line comment covers one.
			stats.CommentLines += int(node.EndPosition().Row-node.StartPosition().Row) + 1
		case sets.imports[kind]:
			stats.Imports++
		case sets.classes[kind]:
			stats.Classes++
		}

		if fn != nil && sets.statements[kind] {
			fn.statements++
		}
	}

	// A branch both counts and deepens everything inside it. Nesting is measured in
	// branches rather than in blocks, because a block is punctuation and a branch is a
	// decision — which is what "how deeply nested is this code" is actually asking.
	childDepth := depth
	if named && sets.branches[kind] {
		stats.Branches++
		childDepth = depth + 1
		if childDepth > stats.MaxNesting {
			stats.MaxNesting = childDepth
		}
		if fn != nil && childDepth-fn.baseDepth > fn.maxNesting {
			fn.maxNesting = childDepth - fn.baseDepth
		}
	}

	child := fn
	if named && sets.functions[kind] {
		stats.Functions++
		if hasAsyncMarker(node, sets) {
			stats.AsyncFunctions++
		}
		// A nested function gets its own accumulator, so its statements and its nesting
		// belong to it rather than inflating the function it happens to sit inside.
		child = &funcAcc{baseDepth: childDepth}
	}

	for i := uint(0); i < node.ChildCount(); i++ {
		walk(node.Child(i), sets, stats, childDepth, child)
	}

	if child != fn && child != nil {
		stats.StatementSum += child.statements
		stats.NestingSum += child.maxNesting
	}
}

// hasAsyncMarker looks only at direct children, so an inner arrow function's `async` does
// not mark the function enclosing it.
func hasAsyncMarker(node *ts.Node, sets *kindSets) bool {
	if len(sets.async) == 0 {
		return false
	}
	for i := uint(0); i < node.ChildCount(); i++ {
		if sets.async[node.Child(i).Kind()] {
			return true
		}
	}
	return false
}

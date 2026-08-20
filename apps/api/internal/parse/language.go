// Package parse turns source files into counts.
//
// docs/features-schema.md sets the constraint that shapes this package: "Adding a language
// must not require touching aggregation code." So every language contributes exactly one
// thing — a table of node kinds — and the walk that counts them is shared. A new language
// is a new table plus one line in the registry, and nothing else moves.
package parse

import (
	"path"
	"strings"

	ts "github.com/tree-sitter/go-tree-sitter"
)

// Kinds names the tree-sitter node kinds that mean something to us in one grammar.
//
// The schema doc says an adapter maps "the four things we count: functions, classes,
// branches, comments". In practice RepoFeatures needs three more — imports appear in
// totals, statements are what avgFunctionLength is measured in, and asyncRatio needs to
// know what asynchrony looks like. Seven sets, all of them just node kinds.
type Kinds struct {
	Functions []string
	Classes   []string
	// Branches are the nodes that fork control flow. They feed cyclomaticDensity, and
	// nesting depth is measured by counting how many of them enclose a point.
	Branches []string
	Comments []string
	Imports  []string
	// Statements are what a function's length is counted in — "in statements, not lines".
	Statements []string
	// Async kinds mark a function asynchronous when they appear as its direct children.
	// Direct rather than anywhere in the subtree, so an inner arrow function's `async` does
	// not leak onto the one enclosing it.
	Async []string
}

type Language struct {
	// Name is what appears in RepoFeatures.languages, so two grammars can share one name.
	Name       string
	Extensions []string
	Grammar    func() *ts.Language
	Kinds      Kinds

	sets kindSets
}

type kindSets struct {
	functions  map[string]bool
	classes    map[string]bool
	branches   map[string]bool
	comments   map[string]bool
	imports    map[string]bool
	statements map[string]bool
	async      map[string]bool
}

func toSet(kinds []string) map[string]bool {
	set := make(map[string]bool, len(kinds))
	for _, kind := range kinds {
		set[kind] = true
	}
	return set
}

func (l *Language) prepare() {
	l.sets = kindSets{
		functions:  toSet(l.Kinds.Functions),
		classes:    toSet(l.Kinds.Classes),
		branches:   toSet(l.Kinds.Branches),
		comments:   toSet(l.Kinds.Comments),
		imports:    toSet(l.Kinds.Imports),
		statements: toSet(l.Kinds.Statements),
		async:      toSet(l.Kinds.Async),
	}
}

var byExtension = map[string]*Language{}

func register(languages ...*Language) {
	for _, language := range languages {
		language.prepare()
		for _, ext := range language.Extensions {
			byExtension[ext] = language
		}
	}
}

// ForPath returns the language a file should be parsed as, if it is one we support.
func ForPath(name string) (*Language, bool) {
	language, ok := byExtension[strings.ToLower(path.Ext(name))]
	return language, ok
}

// Supported reports whether a path is worth fetching at all. It is the predicate the
// archive walker takes, which is what keeps the 2,000-file cap counting files that will
// actually be parsed rather than every image in the repository.
func Supported(name string) bool {
	_, ok := ForPath(name)
	return ok
}

// SupportedName reports whether a language, named the way GitHub names it, is one we parse.
//
// By name rather than by extension because this answers a different question from Supported:
// that one is asked of a path inside an archive we already have, this one is asked of a
// repository we have not fetched, where all we know is the one language GitHub calls its
// primary. Same table behind both.
func SupportedName(name string) bool {
	for _, supported := range Names() {
		if strings.EqualFold(supported, name) {
			return true
		}
	}
	return false
}

// Names lists every supported language, deduplicated and in a stable order. A repository
// with none of them gets a 422 naming these.
func Names() []string {
	seen := map[string]bool{}
	var names []string
	for _, ext := range sortedExtensions() {
		language := byExtension[ext]
		if !seen[language.Name] {
			seen[language.Name] = true
			names = append(names, language.Name)
		}
	}
	return names
}

func sortedExtensions() []string {
	extensions := make([]string, 0, len(byExtension))
	for ext := range byExtension {
		extensions = append(extensions, ext)
	}
	// Sorted so Names() is stable; the map alone would not be.
	for i := 1; i < len(extensions); i++ {
		for j := i; j > 0 && extensions[j] < extensions[j-1]; j-- {
			extensions[j], extensions[j-1] = extensions[j-1], extensions[j]
		}
	}
	return extensions
}

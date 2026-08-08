// Package aggregate turns per-file counts into a RepoFeatures document.
//
// Nothing here knows what a syntax tree is, and nothing here knows what a voice is. It sums
// numbers and rounds them. That is the whole point of the FileStats boundary: adding a
// language cannot reach this file.
//
// Determinism is the requirement that shapes everything below. docs/features-schema.md:
// given the same commitSha the API must emit a byte-identical document. So files are sorted
// before anything is summed, every tie is broken explicitly, and floats are rounded to four
// places before they leave.
package aggregate

import (
	"math"
	"sort"
	"strings"
	"time"

	"codetta.dev/api/internal/parse"
	"codetta.dev/schema"
)

const (
	// MaxModules is the "top 6 directories by LOC" from docs/features-schema.md. They become
	// voices, and the voice budget is fixed at six.
	MaxModules = 6

	// MaxTimeline caps the per-file walk. Beyond it the list is sampled evenly rather than
	// truncated, so the shape of a large repository survives.
	MaxTimeline = 256

	// ModuleDepth is how many path segments make a module. Two, because one is too coarse
	// for a monorepo — every file in React would land in `packages` — and three splits a
	// conventional src/ layout into meaningless slivers.
	ModuleDepth = 2

	// RootModule is where files that sit at the repository root belong. Naming it "." keeps
	// flat repositories from having no modules at all, which would leave them with no voices
	// above the pad and bass.
	RootModule = "."
)

// Input is everything the document needs that this package cannot compute.
type Input struct {
	Owner           string
	Name            string
	Ref             string
	CommitSHA       string
	PrimaryLanguage string
	Stars           int

	Files []parse.FileStats
	// Skipped is the archive walker's count: vendored, generated, oversized, or in a
	// language we do not parse.
	Skipped   int
	FetchedAt time.Time
}

// ModulePath is the module a file belongs to: its directory, truncated to ModuleDepth
// segments. Exported because the timeline has to agree with the module list about this, and
// two implementations of the same rule would eventually disagree.
func ModulePath(file string) string {
	segments := strings.Split(file, "/")
	if len(segments) <= 1 {
		return RootModule
	}
	directory := segments[:len(segments)-1]
	if len(directory) > ModuleDepth {
		directory = directory[:ModuleDepth]
	}
	return strings.Join(directory, "/")
}

func round4(value float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0
	}
	return math.Round(value*10000) / 10000
}

// ratio divides safely and clamps. Both matter: a module with no functions would otherwise
// produce NaN, and commentLines can exceed linesOfCode because a block comment's blank
// lines are comment lines but not lines of code.
func ratio(numerator, denominator int) float64 {
	if denominator <= 0 {
		return 0
	}
	return round4(math.Min(math.Max(float64(numerator)/float64(denominator), 0), 1))
}

// Build assembles the document. Files may arrive in any order — parallel parsing is allowed
// — so the first thing that happens is a sort.
func Build(in Input) schema.RepoFeatures {
	files := make([]parse.FileStats, len(in.Files))
	copy(files, in.Files)
	// Byte-wise, matching the order the timeline promises and the order apps/web asserts.
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })

	totals := buildTotals(files, in.Skipped)
	modules := buildModules(files, totals.LinesOfCode)

	seed := in.CommitSHA
	if len(seed) > 8 {
		seed = seed[:8]
	}

	return schema.RepoFeatures{
		SchemaVersion: schema.SchemaVersion,
		Repo: schema.RepoIdentity{
			Owner:           in.Owner,
			Name:            in.Name,
			Ref:             in.Ref,
			CommitSha:       in.CommitSHA,
			PrimaryLanguage: in.PrimaryLanguage,
			Stars:           in.Stars,
			FetchedAt:       in.FetchedAt.UTC().Format(time.RFC3339),
		},
		Seed:      seed,
		Totals:    totals,
		Languages: buildLanguages(files),
		Modules:   modules,
		Timeline:  buildTimeline(files, modules),
	}
}

func buildTotals(files []parse.FileStats, skipped int) schema.Totals {
	totals := schema.Totals{FilesScanned: len(files), FilesSkipped: skipped}
	for _, file := range files {
		totals.LinesOfCode += file.LinesOfCode
		totals.Functions += file.Functions
		totals.Classes += file.Classes
		totals.Imports += file.Imports
	}
	return totals
}

// buildLanguages reports each language's share of the files scanned.
//
// By file count rather than by lines, because that is what the schema's own example says:
// 290 of 412 files is the 0.71 it shows. The shares have to sum to exactly 1, and rounding
// three of them independently does not, so the largest absorbs the remainder — the entry
// where a ten-thousandth is least visible.
func buildLanguages(files []parse.FileStats) []schema.LanguageShare {
	counts := map[string]int{}
	for _, file := range files {
		counts[file.Language]++
	}
	if len(counts) == 0 {
		return []schema.LanguageShare{}
	}

	languages := make([]schema.LanguageShare, 0, len(counts))
	for name, count := range counts {
		languages = append(languages, schema.LanguageShare{
			Name:  name,
			Files: count,
			Share: round4(float64(count) / float64(len(files))),
		})
	}

	sort.Slice(languages, func(i, j int) bool {
		if languages[i].Files != languages[j].Files {
			return languages[i].Files > languages[j].Files
		}
		return languages[i].Name < languages[j].Name
	})

	var rest float64
	for _, language := range languages[1:] {
		rest += language.Share
	}
	languages[0].Share = round4(1 - rest)

	return languages
}

// moduleAcc sums one directory's files. The averages are computed once at the end, so a
// module's mean is over its functions rather than a mean of per-file means.
type moduleAcc struct {
	path         string
	files        int
	linesOfCode  int
	commentLines int
	functions    int
	classes      int
	branches     int
	nodes        int
	nestingSum   int
	statementSum int
	asyncFuncs   int
	maxNesting   int
}

func buildModules(files []parse.FileStats, totalLines int) []schema.RepoModule {
	accs := map[string]*moduleAcc{}
	for _, file := range files {
		path := ModulePath(file.Path)
		acc := accs[path]
		if acc == nil {
			acc = &moduleAcc{path: path}
			accs[path] = acc
		}
		acc.files++
		acc.linesOfCode += file.LinesOfCode
		acc.commentLines += file.CommentLines
		acc.functions += file.Functions
		acc.classes += file.Classes
		acc.branches += file.Branches
		acc.nodes += file.TotalNodes
		acc.nestingSum += file.NestingSum
		acc.statementSum += file.StatementSum
		acc.asyncFuncs += file.AsyncFunctions
		acc.maxNesting = max(acc.maxNesting, file.MaxNesting)
	}

	ordered := make([]*moduleAcc, 0, len(accs))
	for _, acc := range accs {
		ordered = append(ordered, acc)
	}
	sort.Slice(ordered, func(i, j int) bool {
		if ordered[i].linesOfCode != ordered[j].linesOfCode {
			return ordered[i].linesOfCode > ordered[j].linesOfCode
		}
		// Path breaks the tie, because map order is not an order.
		return ordered[i].path < ordered[j].path
	})
	if len(ordered) > MaxModules {
		ordered = ordered[:MaxModules]
	}

	modules := make([]schema.RepoModule, 0, len(ordered))
	for _, acc := range ordered {
		modules = append(modules, schema.RepoModule{
			Path:        acc.path,
			Share:       ratio(acc.linesOfCode, totalLines),
			Files:       acc.files,
			LinesOfCode: acc.linesOfCode,
			// Mean of each function's own deepest branch nesting.
			AvgNestingDepth: round4(mean(acc.nestingSum, acc.functions)),
			MaxNestingDepth: acc.maxNesting,
			// "In statements, not lines."
			AvgFunctionLength: round4(mean(acc.statementSum, acc.functions)),
			CyclomaticDensity: ratio(acc.branches, acc.nodes),
			CommentRatio:      ratio(acc.commentLines, acc.linesOfCode),
			AsyncRatio:        ratio(acc.asyncFuncs, acc.functions),
		})
	}
	return modules
}

func mean(sum, count int) float64 {
	if count <= 0 {
		return 0
	}
	return float64(sum) / float64(count)
}

// buildTimeline walks the files of the modules that became voices.
//
// Only those modules: the timeline exists so a voice can follow its own module's files, and
// an entry pointing at a directory that produced no voice has nothing to drive.
func buildTimeline(files []parse.FileStats, modules []schema.RepoModule) []schema.TimelineEntry {
	included := make(map[string]bool, len(modules))
	for _, module := range modules {
		included[module.Path] = true
	}

	candidates := make([]parse.FileStats, 0, len(files))
	for _, file := range files {
		module := ModulePath(file.Path)
		if !included[module] {
			continue
		}
		// Root-level files are left out. Every timeline entry's path sits under its
		// modulePath, which is what lets apps/web check attribution without reimplementing
		// the module rule — and "." is not a prefix of "main.go". A flat repository loses
		// its timeline as a result, which costs it the file-driven detail in the peak and
		// nothing else; it still has a module, and therefore still has voices.
		if module == RootModule {
			continue
		}
		candidates = append(candidates, file)
	}

	timeline := make([]schema.TimelineEntry, 0, min(len(candidates), MaxTimeline))
	for index, file := range sample(candidates, MaxTimeline) {
		timeline = append(timeline, schema.TimelineEntry{
			Index:        index,
			ModulePath:   ModulePath(file.Path),
			Path:         file.Path,
			LinesOfCode:  file.LinesOfCode,
			Functions:    file.Functions,
			MaxNesting:   file.MaxNesting,
			Branches:     file.Branches,
			CommentLines: file.CommentLines,
		})
	}
	return timeline
}

// sample thins a sorted list to at most limit entries, spread evenly and keeping both ends.
// Truncating instead would describe only the first alphabetical corner of a repository.
func sample(files []parse.FileStats, limit int) []parse.FileStats {
	if len(files) <= limit {
		return files
	}

	out := make([]parse.FileStats, 0, limit)
	for i := range limit {
		index := int(math.Round(float64(i) * float64(len(files)-1) / float64(limit-1)))
		out = append(out, files[index])
	}
	return out
}

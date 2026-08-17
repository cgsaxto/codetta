package aggregate

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"testing"
	"time"

	"codetta.dev/api/internal/parse"
	"codetta.dev/schema"
)

const sha = "7c8e5e7ab2f0d5a1c4b93f6e2d8a105f3bc47e9d"

func file(path string, loc, functions int) parse.FileStats {
	return parse.FileStats{
		Path:        path,
		Language:    "Go",
		LinesOfCode: loc,
		Functions:   functions,
		TotalNodes:  loc * 5,
	}
}

func build(files []parse.FileStats) schema.RepoFeatures {
	return Build(Input{
		Owner:     "o",
		Name:      "r",
		Ref:       "main",
		CommitSHA: sha,
		Files:     files,
		FetchedAt: time.Date(2026, 8, 8, 12, 0, 0, 0, time.UTC),
	})
}

func TestModulePath(t *testing.T) {
	cases := map[string]string{
		// Two segments, because one would put every file in React into `packages`.
		"packages/react-dom/src/client/x.js": "packages/react-dom",
		"packages/react-dom/index.js":        "packages/react-dom",
		"src/music/voices/lead.ts":           "src/music",
		"src/app.ts":                         "src",
		// A flat repository still has one module rather than none.
		"main.go": RootModule,
	}
	for path, want := range cases {
		if got := ModulePath(path); got != want {
			t.Errorf("ModulePath(%q) = %q, want %q", path, got, want)
		}
	}
}

func TestSortsFilesBeforeSummingAnything(t *testing.T) {
	// Parallel parsing is allowed, so files arrive in whatever order they finished in. The
	// document has to be byte-identical regardless.
	forward := []parse.FileStats{
		file("a/b/one.go", 10, 1),
		file("a/b/two.go", 20, 2),
		file("c/d/three.go", 30, 3),
	}
	reversed := []parse.FileStats{forward[2], forward[0], forward[1]}

	first, err := json.Marshal(build(forward))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	second, err := json.Marshal(build(reversed))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if string(first) != string(second) {
		t.Error("input order changed the document")
	}
}

func TestSeedIsTheFirstEightCharsOfTheSHA(t *testing.T) {
	features := build([]parse.FileStats{file("a/b.go", 1, 0)})
	if features.Seed != sha[:8] {
		t.Errorf("Seed = %q, want %q", features.Seed, sha[:8])
	}
}

func TestLanguageSharesSumToExactlyOne(t *testing.T) {
	// Three shares rounded independently do not sum to 1, and apps/web asserts that they do.
	// The largest absorbs the remainder.
	files := []parse.FileStats{}
	for i := range 7 {
		files = append(files, parse.FileStats{
			Path: fmt.Sprintf("a/b/f%d.go", i), Language: "Go", LinesOfCode: 1,
		})
	}
	for i := range 5 {
		files = append(files, parse.FileStats{
			Path: fmt.Sprintf("a/b/f%d.py", i), Language: "Python", LinesOfCode: 1,
		})
	}
	files = append(files, parse.FileStats{
		Path: "a/b/x.ts", Language: "TypeScript", LinesOfCode: 1,
	})

	var sum float64
	for _, language := range build(files).Languages {
		sum += language.Share
	}
	if math.Abs(sum-1) > 1e-9 {
		t.Errorf("shares sum to %v, want exactly 1", sum)
	}
}

func TestLanguagesAreOrderedBySize(t *testing.T) {
	files := []parse.FileStats{
		{Path: "a/b/1.py", Language: "Python", LinesOfCode: 1},
		{Path: "a/b/2.go", Language: "Go", LinesOfCode: 1},
		{Path: "a/b/3.go", Language: "Go", LinesOfCode: 1},
	}
	languages := build(files).Languages
	if languages[0].Name != "Go" || languages[1].Name != "Python" {
		t.Errorf("order = %v, want Go before Python", languages)
	}
}

func TestKeepsOnlyTheSixLargestModules(t *testing.T) {
	var files []parse.FileStats
	for i := range 10 {
		// Descending size, so the expected survivors are unambiguous.
		files = append(files, file(fmt.Sprintf("mod%02d/src/x.go", i), 100-i, 1))
	}

	modules := build(files).Modules
	if len(modules) != MaxModules {
		t.Fatalf("got %d modules, want %d", len(modules), MaxModules)
	}
	for i := 1; i < len(modules); i++ {
		if modules[i-1].LinesOfCode < modules[i].LinesOfCode {
			t.Errorf("modules are not ordered by size: %v", modules)
		}
	}
	if modules[0].Path != "mod00/src" {
		t.Errorf("largest module = %q", modules[0].Path)
	}
}

func TestModuleAveragesAreOverFunctionsNotOverFiles(t *testing.T) {
	// A mean of per-file means would weight a one-function file the same as a hundred-
	// function one.
	files := []parse.FileStats{
		{Path: "m/s/a.go", Language: "Go", LinesOfCode: 10, Functions: 1, NestingSum: 1, StatementSum: 2, TotalNodes: 50},
		{Path: "m/s/b.go", Language: "Go", LinesOfCode: 10, Functions: 9, NestingSum: 27, StatementSum: 90, TotalNodes: 50},
	}
	module := build(files).Modules[0]

	// (1 + 27) / 10 functions
	if module.AvgNestingDepth != 2.8 {
		t.Errorf("AvgNestingDepth = %v, want 2.8", module.AvgNestingDepth)
	}
	// (2 + 90) / 10 functions
	if module.AvgFunctionLength != 9.2 {
		t.Errorf("AvgFunctionLength = %v, want 9.2", module.AvgFunctionLength)
	}
}

func TestRatiosStayInsideZeroToOne(t *testing.T) {
	// commentLines can exceed linesOfCode: a block comment's blank lines are comment lines
	// but are not lines of code. Unclamped that produces a ratio above 1, which apps/web
	// rejects.
	files := []parse.FileStats{{
		Path: "m/s/a.go", Language: "Go",
		LinesOfCode: 2, CommentLines: 10, Functions: 1, AsyncFunctions: 4,
		Branches: 100, TotalNodes: 10,
	}}

	module := build(files).Modules[0]
	for name, value := range map[string]float64{
		"CommentRatio":      module.CommentRatio,
		"AsyncRatio":        module.AsyncRatio,
		"CyclomaticDensity": module.CyclomaticDensity,
		"Share":             module.Share,
	} {
		if value < 0 || value > 1 {
			t.Errorf("%s = %v, want 0-1", name, value)
		}
	}
}

func TestEmptyModuleDoesNotDivideByZero(t *testing.T) {
	files := []parse.FileStats{{Path: "m/s/a.go", Language: "Go", LinesOfCode: 3}}
	module := build(files).Modules[0]

	for name, value := range map[string]float64{
		"AvgNestingDepth":   module.AvgNestingDepth,
		"AvgFunctionLength": module.AvgFunctionLength,
		"AsyncRatio":        module.AsyncRatio,
	} {
		if math.IsNaN(value) || math.IsInf(value, 0) {
			t.Errorf("%s = %v", name, value)
		}
	}
}

func TestEveryFloatIsRoundedToFourPlaces(t *testing.T) {
	files := []parse.FileStats{
		{Path: "m/s/a.go", Language: "Go", LinesOfCode: 7, CommentLines: 1, Functions: 3,
			NestingSum: 5, StatementSum: 11, Branches: 2, TotalNodes: 37, AsyncFunctions: 1},
		{Path: "m/s/b.py", Language: "Python", LinesOfCode: 6, Functions: 1, TotalNodes: 13},
	}

	features := build(files)
	check := func(name string, value float64) {
		if math.Abs(value-round4(value)) > 1e-12 {
			t.Errorf("%s = %v, not rounded to four places", name, value)
		}
	}
	for _, language := range features.Languages {
		check("language share", language.Share)
	}
	for _, module := range features.Modules {
		check("share", module.Share)
		check("avgNestingDepth", module.AvgNestingDepth)
		check("avgFunctionLength", module.AvgFunctionLength)
		check("cyclomaticDensity", module.CyclomaticDensity)
		check("commentRatio", module.CommentRatio)
		check("asyncRatio", module.AsyncRatio)
	}
}

func TestTimelineIsOrderedIndexedAndAttributed(t *testing.T) {
	files := []parse.FileStats{
		file("b/x/2.go", 5, 1),
		file("a/x/1.go", 5, 1),
		file("a/x/0.go", 5, 1),
	}
	timeline := build(files).Timeline

	for i, entry := range timeline {
		if entry.Index != i {
			t.Errorf("entry %d has index %d", i, entry.Index)
		}
		if !strings.HasPrefix(entry.Path, entry.ModulePath+"/") {
			t.Errorf("%q is not inside %q", entry.Path, entry.ModulePath)
		}
		if i > 0 && timeline[i-1].Path >= entry.Path {
			t.Errorf("timeline is not sorted: %q then %q", timeline[i-1].Path, entry.Path)
		}
	}
}

func TestTimelineOnlyCoversModulesThatBecameVoices(t *testing.T) {
	// An entry pointing at a directory that produced no voice has nothing to drive.
	var files []parse.FileStats
	for i := range 8 {
		files = append(files, file(fmt.Sprintf("mod%02d/src/x.go", i), 100-i, 1))
	}

	features := build(files)
	kept := map[string]bool{}
	for _, module := range features.Modules {
		kept[module.Path] = true
	}
	for _, entry := range features.Timeline {
		if !kept[entry.ModulePath] {
			t.Errorf("timeline references %q, which is not a module", entry.ModulePath)
		}
	}
	if len(features.Timeline) != MaxModules {
		t.Errorf("timeline has %d entries, want one per surviving module", len(features.Timeline))
	}
}

func TestTimelineSamplesRatherThanTruncates(t *testing.T) {
	// Truncating would describe only the first alphabetical corner of a large repository.
	var files []parse.FileStats
	for i := range 1000 {
		files = append(files, file(fmt.Sprintf("m/s/f%04d.go", i), 10, 1))
	}

	timeline := build(files).Timeline
	if len(timeline) != MaxTimeline {
		t.Fatalf("got %d entries, want %d", len(timeline), MaxTimeline)
	}
	// Both ends survive, which is what makes it a sample rather than a prefix.
	if timeline[0].Path != "m/s/f0000.go" {
		t.Errorf("first entry = %q", timeline[0].Path)
	}
	if last := timeline[len(timeline)-1].Path; last != "m/s/f0999.go" {
		t.Errorf("last entry = %q, want the final file", last)
	}
}

func TestRootLevelFilesStillFormAModule(t *testing.T) {
	// A flat repository would otherwise have no modules at all, and therefore no voices
	// above the pad and bass.
	features := build([]parse.FileStats{file("main.go", 20, 2), file("util.go", 10, 1)})

	if len(features.Modules) != 1 || features.Modules[0].Path != RootModule {
		t.Fatalf("modules = %v, want one %q", features.Modules, RootModule)
	}
}

// attributed reports whether an entry's modulePath is the one its path implies. The rule in
// full, root included: "." exactly when the path has no directory, and otherwise a prefix.
func attributed(entry schema.TimelineEntry) bool {
	if entry.ModulePath == RootModule {
		return !strings.Contains(entry.Path, "/")
	}
	return strings.HasPrefix(entry.Path, entry.ModulePath+"/")
}

func TestAFlatRepositoryReachesTheTimeline(t *testing.T) {
	// The regression this exists for. Go projects put a package's files at the repository
	// root, so `ModulePath` calls them "." — and while root files were dropped from the
	// timeline to keep a prefix test working, urfave/cli was 97% root files and 97% absent
	// from the document meant to describe it. The music lost the detail; the visualiser lost
	// the picture entirely, because it draws the timeline.
	stats := []parse.FileStats{
		file("main.go", 40, 4),
		file("cli.go", 120, 12),
		file("flag.go", 90, 9),
		file("context.go", 60, 6),
	}

	features := build(stats)

	if len(features.Timeline) != len(stats) {
		t.Fatalf("timeline has %d entries, want %d — the repository is the root",
			len(features.Timeline), len(stats))
	}
	for _, entry := range features.Timeline {
		if entry.ModulePath != RootModule {
			t.Errorf("%s attributed to %q, want %q", entry.Path, entry.ModulePath, RootModule)
		}
		if !attributed(entry) {
			t.Errorf("%s does not sit under %q", entry.Path, entry.ModulePath)
		}
	}
}

func TestRootAndNestedPackagesEachClaimTheirOwnFiles(t *testing.T) {
	// The other half: a repository with both, where the risk is a file counted twice or
	// claimed by the wrong module. `ModulePath` is a pure function of the path, so this
	// cannot happen by construction — which is exactly the kind of claim worth a test,
	// because it stops being true the moment someone makes attribution stateful.
	stats := []parse.FileStats{
		file("main.go", 30, 3),
		file("doc.go", 10, 1),
		file("internal/cbor/decode.go", 80, 8),
		file("internal/cbor/encode.go", 70, 7),
		file("internal/json/parse.go", 60, 6),
		file("hlog/handler.go", 50, 5),
	}

	features := build(stats)

	want := map[string]string{
		"main.go":                 RootModule,
		"doc.go":                  RootModule,
		"internal/cbor/decode.go": "internal/cbor",
		"internal/cbor/encode.go": "internal/cbor",
		"internal/json/parse.go":  "internal/json",
		"hlog/handler.go":         "hlog",
	}

	seen := map[string]int{}
	for _, entry := range features.Timeline {
		seen[entry.Path]++
		if got := entry.ModulePath; got != want[entry.Path] {
			t.Errorf("%s attributed to %q, want %q", entry.Path, got, want[entry.Path])
		}
		if !attributed(entry) {
			t.Errorf("%s does not sit under %q", entry.Path, entry.ModulePath)
		}
	}

	for path := range want {
		if seen[path] != 1 {
			t.Errorf("%s appears %d times in the timeline, want exactly 1", path, seen[path])
		}
	}

	// And the module list agrees with the timeline about who owns what, rather than the two
	// being derived independently and drifting.
	files := 0
	for _, module := range features.Modules {
		files += module.Files
	}
	if files != len(stats) {
		t.Errorf("modules account for %d files, want %d", files, len(stats))
	}
}

func TestFetchedAtIsUTCAndRFC3339(t *testing.T) {
	features := Build(Input{
		Owner: "o", Name: "r", CommitSHA: sha,
		Files:     []parse.FileStats{file("a/b.go", 1, 0)},
		FetchedAt: time.Date(2026, 8, 8, 12, 0, 0, 0, time.FixedZone("x", 3600)),
	})
	if features.Repo.FetchedAt != "2026-08-08T11:00:00Z" {
		t.Errorf("FetchedAt = %q", features.Repo.FetchedAt)
	}
}

func TestEmptyRepoProducesAValidDocument(t *testing.T) {
	features := Build(Input{Owner: "o", Name: "r", CommitSHA: sha, Skipped: 12})

	if features.Languages == nil || features.Modules == nil || features.Timeline == nil {
		t.Error("slices must be empty rather than null; the schema forbids nulls")
	}
	if features.Totals.FilesSkipped != 12 {
		t.Errorf("FilesSkipped = %d, want 12", features.Totals.FilesSkipped)
	}

	encoded, err := json.Marshal(features)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(encoded), "null") {
		t.Errorf("document contains null: %s", encoded)
	}
}

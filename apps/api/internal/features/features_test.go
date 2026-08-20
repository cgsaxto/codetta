package features

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"testing"
	"time"

	"codetta.dev/api/internal/github"
)

// The end-to-end check, offline. A tarball is built in memory, walked, parsed and
// aggregated — the same path a real repository takes, minus the network.

const sha = "7c8e5e7ab2f0d5a1c4b93f6e2d8a105f3bc47e9d"

// A small repository with the shape that matters: two modules of different sizes, all four
// supported languages, and files that every skip rule has an opinion about.
var fixtureRepo = map[string]string{
	"packages/core/src/index.ts": `import { helper } from "../util"

export interface Options { deep: boolean }

export class Engine {
  async run(options: Options): Promise<void> {
    if (options.deep) {
      for (const step of this.steps) {
        if (step.ready) { await step.run() }
      }
    }
  }
  private steps: Step[] = []
}`,
	"packages/core/src/util.ts": `// A helper, and a comment about it.
export function helper(n: number): number {
  return n > 0 ? n : -n
}`,
	"packages/cli/main.go": `package main

import "fmt"
import "os"

type Config struct{ Verbose bool }

// Run is the entry point.
func Run(cfg Config) error {
	if cfg.Verbose {
		fmt.Println("verbose")
	}
	return nil
}

func main() { os.Exit(0) }`,
	"packages/core/src/legacy.js": `const { readFile } = require("fs/promises")

// Kept for the old entry point. Deliberately unlike the TypeScript beside it: no types, a
// promise chain rather than await, and a comment ratio of its own.
class Loader {
  constructor(root) {
    this.root = root
  }

  async load(names) {
    const out = []
    for (const name of names) {
      if (name) {
        try {
          out.push(await readFile(this.root + "/" + name))
        } catch (err) {
          if (err.code !== "ENOENT") throw err
        }
      }
    }
    return out
  }
}

module.exports = { Loader }`,
	"packages/cli/tool.py": `import sys

class Tool:
    async def run(self):
        if sys.argv:
            for arg in sys.argv:
                await self.handle(arg)`,

	// At the repository root, which Go projects do as a matter of convention. It has to reach
	// the timeline attributed to ".", and dropping files like this is what made urfave/cli
	// 97% absent from its own document.
	"doc.go": `// Package fixture is the whole point of this file: it sits at the root.
package fixture

const Version = "1"`,

	// None of the following may reach the document.
	"node_modules/dep/index.js": "module.exports = {}",
	"packages/core/dist/out.js": "var a=1",
	"package-lock.json":         `{"lockfileVersion":3}`,
	"logo.png":                  "\x89PNG not source",
	"README.md":                 "# docs",
}

// sortedNames is the order buildFixture writes in by default. Fixed, so the archive bytes
// are reproducible; the pipeline sorts anyway, which is what the ordering tests lean on.
func sortedNames(files map[string]string) []string {
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func buildFixture(t *testing.T, files map[string]string) []byte {
	t.Helper()
	return buildFixtureInOrder(t, files, sortedNames(files))
}

// buildFixtureInOrder writes the same repository with the tar entries in a given sequence.
// The paths inside the archive are untouched — only the order the archive presents them in
// changes, which is the one thing a tarball gives no guarantees about.
func buildFixtureInOrder(t *testing.T, files map[string]string, names []string) []byte {
	t.Helper()

	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)

	for _, name := range names {
		body := files[name]
		header := &tar.Header{
			Name:     "o-r-" + sha[:7] + "/" + name,
			Mode:     0o644,
			Size:     int64(len(body)),
			Typeflag: tar.TypeReg,
		}
		if err := tw.WriteHeader(header); err != nil {
			t.Fatalf("header %s: %v", name, err)
		}
		if _, err := tw.Write([]byte(body)); err != nil {
			t.Fatalf("body %s: %v", name, err)
		}
	}

	if err := tw.Close(); err != nil {
		t.Fatalf("closing tar: %v", err)
	}
	if err := gz.Close(); err != nil {
		t.Fatalf("closing gzip: %v", err)
	}
	return buf.Bytes()
}

func run(t *testing.T, files map[string]string) string {
	t.Helper()

	repo := github.Repo{
		Owner: "o", Name: "r", Ref: "main",
		CommitSHA: sha, PrimaryLanguage: "TypeScript", Stars: 42,
	}
	fetchedAt := time.Date(2026, 8, 8, 12, 0, 0, 0, time.UTC)

	document, err := FromTarball(
		context.Background(), repo, bytes.NewReader(buildFixture(t, files)), fetchedAt)
	if err != nil {
		t.Fatalf("FromTarball: %v", err)
	}

	encoded, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(encoded)
}

func TestPipelineIsByteIdenticalAcrossRuns(t *testing.T) {
	// The promise from docs/features-schema.md: the same commit produces the same document,
	// byte for byte. Everything downstream — the cache key, the seed, the music — rests on
	// it, and nothing else in the suite would notice if it broke.
	first := run(t, fixtureRepo)
	for range 5 {
		if again := run(t, fixtureRepo); again != first {
			t.Fatal("the same repository produced two different documents")
		}
	}
}

func TestPipelineExcludesEverythingItShould(t *testing.T) {
	document := run(t, fixtureRepo)

	for _, forbidden := range []string{
		"node_modules", "dist/out.js", "package-lock.json", "logo.png", "README.md",
	} {
		if strings.Contains(document, forbidden) {
			t.Errorf("%s reached the document", forbidden)
		}
	}
}

func TestPipelineCountsWhatItKept(t *testing.T) {
	document := run(t, fixtureRepo)

	var parsed struct {
		Totals struct {
			FilesScanned int `json:"filesScanned"`
			FilesSkipped int `json:"filesSkipped"`
		} `json:"totals"`
		Languages []struct {
			Name string `json:"name"`
		} `json:"languages"`
		Modules []struct {
			Path string `json:"path"`
		} `json:"modules"`
	}
	if err := json.Unmarshal([]byte(document), &parsed); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if parsed.Totals.FilesScanned != 6 {
		t.Errorf("FilesScanned = %d, want 6", parsed.Totals.FilesScanned)
	}
	// The five files that were seen and rejected. Skipping is a counted outcome, not a
	// silent one — the totals still add up to what the archive contained.
	if parsed.Totals.FilesSkipped != 5 {
		t.Errorf("FilesSkipped = %d, want 5", parsed.Totals.FilesSkipped)
	}
	// All four supported languages, so the golden document exercises every adapter in the
	// registry rather than most of them.
	if len(parsed.Languages) != 4 {
		t.Errorf("languages = %v, want all four supported languages", parsed.Languages)
	}

	paths := make([]string, 0, len(parsed.Modules))
	for _, module := range parsed.Modules {
		paths = append(paths, module.Path)
	}
	// Two segments of directory, so the monorepo splits where a reader would split it, plus
	// the repository root as a module of its own — a file at the top level belongs to the
	// repository rather than to nothing.
	sort.Strings(paths)
	want := []string{".", "packages/cli", "packages/core"}
	if got := strings.Join(paths, " "); got != strings.Join(want, " ") {
		t.Errorf("modules = %q, want %q", got, strings.Join(want, " "))
	}
}

func TestRootLevelFilesReachTheTimeline(t *testing.T) {
	// End to end, through the real walker and the real parser. The unit-level version of this
	// lives in aggregate; this is the one that would have caught urfave/cli, where 97% of the
	// repository sits at the root and 97% of it was missing from the document.
	var parsed struct {
		Timeline []struct {
			Path       string `json:"path"`
			ModulePath string `json:"modulePath"`
		} `json:"timeline"`
	}
	if err := json.Unmarshal([]byte(run(t, fixtureRepo)), &parsed); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	var root int
	for _, entry := range parsed.Timeline {
		// The attribution rule in full: "." exactly when the path has no directory, and a
		// prefix otherwise.
		if entry.ModulePath == "." {
			root++
			if strings.Contains(entry.Path, "/") {
				t.Errorf("%s is attributed to the root but sits in a directory", entry.Path)
			}
			continue
		}
		if !strings.HasPrefix(entry.Path, entry.ModulePath+"/") {
			t.Errorf("%s does not sit under %q", entry.Path, entry.ModulePath)
		}
	}

	if root != 1 {
		t.Errorf("%d root files in the timeline, want the 1 the fixture has", root)
	}
}

func TestPipelineRefusesARepositoryItCannotRead(t *testing.T) {
	// A normal outcome for a C or Lua repository, not a failure of this service — and the
	// message has to name what would have worked.
	_, err := FromTarball(
		context.Background(),
		github.Repo{Owner: "o", Name: "r", CommitSHA: sha},
		bytes.NewReader(buildFixture(t, map[string]string{
			"main.c":    "int main(){return 0;}",
			"README.md": "# docs",
		})),
		time.Now(),
	)

	if !errors.Is(err, ErrNoSupportedFiles) {
		t.Fatalf("err = %v, want ErrNoSupportedFiles", err)
	}
	for _, language := range []string{"Go", "JavaScript", "Python", "TypeScript"} {
		if !strings.Contains(NoSupportedFilesMessage(), language) {
			t.Errorf("message does not name %s: %s", language, NoSupportedFilesMessage())
		}
	}
}

func TestPipelineHonoursTheWallClock(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, err := FromTarball(
		ctx,
		github.Repo{Owner: "o", Name: "r", CommitSHA: sha},
		bytes.NewReader(buildFixture(t, fixtureRepo)),
		time.Now(),
	)
	if err == nil {
		t.Fatal("completed with a cancelled context")
	}
}

func TestDocumentConformsToTheSchema(t *testing.T) {
	// packages/schema's own tests check the fixtures; this checks what the service actually
	// emits, which is the thing apps/web will receive.
	document := run(t, fixtureRepo)

	if strings.Contains(document, "null") {
		t.Errorf("document contains null, which the schema forbids:\n%s", document)
	}
	if !strings.Contains(document, `"schemaVersion": 1`) {
		t.Error("document does not declare schemaVersion 1")
	}
	if !strings.Contains(document, `"seed": "`+sha[:8]+`"`) {
		t.Error("seed is not the first eight characters of the commit sha")
	}
}

func TestChooseRepoTakesTheFirstOneWeCanRead(t *testing.T) {
	// Most-starred first, which is how the search endpoint returns them. The top two are
	// languages this service has no grammar for, so the answer is the third.
	candidates := []github.Repo{
		{Owner: "torvalds", Name: "linux", PrimaryLanguage: "C", Stars: 190000},
		{Owner: "torvalds", Name: "subsurface", PrimaryLanguage: "C++", Stars: 900},
		{Owner: "torvalds", Name: "pesconvert", PrimaryLanguage: "Go", Stars: 60},
		{Owner: "torvalds", Name: "test-tlb", PrimaryLanguage: "Python", Stars: 10},
	}

	chosen, err := ChooseRepo(candidates)
	if err != nil {
		t.Fatalf("ChooseRepo: %v", err)
	}
	if chosen.Name != "pesconvert" {
		t.Errorf("chose %q, want the most-starred one in a language we parse", chosen.Name)
	}
}

func TestChooseRepoRefusesWhenNothingIsReadable(t *testing.T) {
	// The same error a repository of C files produces, because it is the same answer, and the
	// caller turns both into the same 422.
	_, err := ChooseRepo([]github.Repo{
		{Name: "linux", PrimaryLanguage: "C"},
		{Name: "unset", PrimaryLanguage: ""},
	})
	if !errors.Is(err, ErrNoSupportedFiles) {
		t.Errorf("error = %v, want ErrNoSupportedFiles", err)
	}
}

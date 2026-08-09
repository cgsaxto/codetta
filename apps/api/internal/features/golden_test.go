package features

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"codetta.dev/api/internal/github"
)

// The golden document.
//
// Every other test in this package asserts a property — this file is skipped, that count is
// four, the seed matches the sha. Each of those is worth having and none of them would
// notice if a nesting sum shifted by one, which is exactly the kind of change that reaches
// the music as a different note and reaches a reviewer as nothing at all.
//
// So the whole document is recorded. A diff here is not automatically a bug: most changes to
// the parser or the aggregation move these numbers on purpose. It means look at what moved,
// decide whether you meant it, and run `make api-golden` in the commit that justifies it.
//
// This is the same arrangement as fixtures/*.expected.json on the web side, for the same
// reason and with the same escape hatch.

var update = flag.Bool("update", false, "rewrite the golden document from the current output")

const goldenPath = "testdata/repo.golden.json"

// documentFrom runs the pipeline over an archive with everything that is not derived from
// the commit pinned, so the only thing that can move the output is the code under test.
//
// `stars` and `fetchedAt` are the two fields that are not derived from the commit, and both
// are held fixed here rather than filtered out afterwards. They are the reason
// docs/features-schema.md excludes them from any equality check: two fetches of vuejs/core
// at one SHA produced byte-identical documents except for a star count that had moved by
// five in the minute between them.
func documentFrom(t *testing.T, archive []byte) []byte {
	t.Helper()

	repo := github.Repo{
		Owner: "o", Name: "r", Ref: "main",
		CommitSHA: sha, PrimaryLanguage: "TypeScript", Stars: 42,
	}

	features, err := FromTarball(
		context.Background(),
		repo,
		bytes.NewReader(archive),
		time.Date(2026, 8, 8, 12, 0, 0, 0, time.UTC),
	)
	if err != nil {
		t.Fatalf("FromTarball: %v", err)
	}

	encoded, err := json.MarshalIndent(features, "", "  ")
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return append(encoded, '\n')
}

func TestGoldenDocument(t *testing.T) {
	got := documentFrom(t, buildFixture(t, fixtureRepo))

	if *update {
		if err := os.MkdirAll(filepath.Dir(goldenPath), 0o755); err != nil {
			t.Fatalf("creating testdata: %v", err)
		}
		if err := os.WriteFile(goldenPath, got, 0o644); err != nil {
			t.Fatalf("writing golden: %v", err)
		}
		t.Logf("wrote %s", goldenPath)
		return
	}

	want, err := os.ReadFile(goldenPath)
	if err != nil {
		t.Fatalf("reading golden: %v (run `make api-golden` to create it)", err)
	}
	if bytes.Equal(got, want) {
		return
	}

	t.Errorf("the document changed.\n%s\nIf that was the intention, run `make api-golden`.",
		firstDifference(string(want), string(got)))
}

// firstDifference reports the first line that moved, because a whole-document dump of a
// 300-line JSON file tells a reader nothing about what actually changed.
func firstDifference(want, got string) string {
	wantLines := strings.Split(want, "\n")
	gotLines := strings.Split(got, "\n")

	for i := range max(len(wantLines), len(gotLines)) {
		w, g := lineAt(wantLines, i), lineAt(gotLines, i)
		if w == g {
			continue
		}
		return fmt.Sprintf("line %d:\n  want: %s\n  got:  %s", i+1, w, g)
	}
	return "the documents differ in length only"
}

func lineAt(lines []string, i int) string {
	if i < len(lines) {
		return lines[i]
	}
	return "<end of file>"
}

func TestTarOrderCannotReachTheDocument(t *testing.T) {
	// docs/features-schema.md: "File traversal order is depth-first, lexicographic by path.
	// Never filesystem order." A tarball's order is whatever the server felt like, and it is
	// close enough to sorted most of the time to hide a dependency on it for a long while.
	//
	// End-to-end, and deliberately not a check on any one layer: the archive sorts and the
	// aggregation sorts again, so removing either alone leaves this passing. That redundancy
	// is the point — the guarantee belongs to the pipeline rather than to a line of code, and
	// this fails only if the property itself is gone. The place where a single sort really is
	// load-bearing is the file cap, where order decides which files are read at all rather
	// than what order they are read in, and archive's own tests pin that one directly.
	sorted := sortedNames(fixtureRepo)
	forward := documentFrom(t, buildFixtureInOrder(t, fixtureRepo, sorted))

	for name, order := range map[string][]string{
		"reverse": reverse(sorted),
		"rotated": rotate(sorted, len(sorted)/2),
	} {
		t.Run(name, func(t *testing.T) {
			got := documentFrom(t, buildFixtureInOrder(t, fixtureRepo, order))
			if !bytes.Equal(got, forward) {
				t.Errorf("%s tar order produced a different document:\n%s",
					name, firstDifference(string(forward), string(got)))
			}
		})
	}
}

func reverse(names []string) []string {
	out := make([]string, len(names))
	for i, name := range names {
		out[len(names)-1-i] = name
	}
	return out
}

func rotate(names []string, by int) []string {
	out := make([]string, 0, len(names))
	for i := range names {
		out = append(out, names[(i+by)%len(names)])
	}
	return out
}

package archive

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"fmt"
	"strings"
	"testing"
	"time"
)

// Every test here builds its own archive in memory. Nothing touches the network, so
// `make api-test` runs offline and does not spend anyone's rate limit.

type entry struct {
	name string
	body string
	typ  byte
}

func buildArchive(t *testing.T, root string, entries []entry) []byte {
	t.Helper()

	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)

	for _, e := range entries {
		typ := e.typ
		if typ == 0 {
			typ = tar.TypeReg
		}
		header := &tar.Header{
			Name:     root + "/" + e.name,
			Mode:     0o644,
			Size:     int64(len(e.body)),
			Typeflag: typ,
		}
		if typ != tar.TypeReg {
			header.Size = 0
		}
		if err := tw.WriteHeader(header); err != nil {
			t.Fatalf("writing header %s: %v", e.name, err)
		}
		if typ == tar.TypeReg {
			if _, err := tw.Write([]byte(e.body)); err != nil {
				t.Fatalf("writing body %s: %v", e.name, err)
			}
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

func acceptAll(string) bool { return true }

func walk(t *testing.T, archive []byte, limits Limits, accept func(string) bool) Result {
	t.Helper()

	result, err := Walk(context.Background(), bytes.NewReader(archive), limits, accept)
	if err != nil {
		t.Fatalf("walking: %v", err)
	}
	return result
}

func paths(result Result) []string {
	out := make([]string, 0, len(result.Files))
	for _, f := range result.Files {
		out = append(out, f.Path)
	}
	return out
}

func TestStripsTheWrapperDirectory(t *testing.T) {
	// GitHub wraps every tarball in an owner-repo-sha directory that is not part of anyone's
	// repository. Left in place it would appear as the top module in every single result.
	archive := buildArchive(t, "facebook-react-7c8e5e7", []entry{
		{name: "packages/react/index.js", body: "export {}"},
	})

	got := paths(walk(t, archive, DefaultLimits(), acceptAll))
	want := "packages/react/index.js"
	if len(got) != 1 || got[0] != want {
		t.Errorf("paths = %v, want [%s]", got, want)
	}
}

func TestSkipsVendoredAndGeneratedPaths(t *testing.T) {
	archive := buildArchive(t, "o-r-sha", []entry{
		{name: "src/app.ts", body: "ok"},
		{name: "node_modules/left-pad/index.js", body: "no"},
		{name: "packages/x/vendor/dep.go", body: "no"},
		{name: "dist/bundle.js", body: "no"},
		{name: "build/out.js", body: "no"},
		{name: "internal/testdata/sample.go", body: "no"},
		{name: "web/app.min.js", body: "no"},
		{name: "package-lock.json", body: "no"},
		{name: "go.sum", body: "no"},
	})

	result := walk(t, archive, DefaultLimits(), acceptAll)
	if got := paths(result); len(got) != 1 || got[0] != "src/app.ts" {
		t.Errorf("kept %v, want only src/app.ts", got)
	}
	if result.Skipped != 8 {
		t.Errorf("Skipped = %d, want 8", result.Skipped)
	}
}

func TestCountsUnwantedLanguagesAsSkipped(t *testing.T) {
	// The schema doc is explicit that unsupported languages count toward filesSkipped rather
	// than vanishing, so a repository's totals still add up.
	archive := buildArchive(t, "o-r-sha", []entry{
		{name: "main.go", body: "package main"},
		{name: "logo.png", body: "\x89PNG"},
		{name: "README.md", body: "# hi"},
	})

	result := walk(t, archive, DefaultLimits(), func(name string) bool {
		return strings.HasSuffix(name, ".go")
	})

	if got := paths(result); len(got) != 1 || got[0] != "main.go" {
		t.Errorf("kept %v, want only main.go", got)
	}
	if result.Skipped != 2 {
		t.Errorf("Skipped = %d, want 2", result.Skipped)
	}
}

func TestSkipsFilesOverTheSizeCap(t *testing.T) {
	limits := DefaultLimits()
	limits.MaxFileBytes = 16

	archive := buildArchive(t, "o-r-sha", []entry{
		{name: "small.go", body: "package main"},
		{name: "huge.go", body: strings.Repeat("x", 64)},
	})

	result := walk(t, archive, limits, acceptAll)
	if got := paths(result); len(got) != 1 || got[0] != "small.go" {
		t.Errorf("kept %v, want only small.go", got)
	}
	if result.Skipped != 1 {
		t.Errorf("Skipped = %d, want 1", result.Skipped)
	}
}

func TestStopsAtTheFileCapWithoutFailing(t *testing.T) {
	// Exceeding a limit is a normal outcome. A repository with more files than the cap must
	// still produce a usable result rather than an error.
	limits := DefaultLimits()
	limits.MaxFiles = 3

	entries := make([]entry, 0, 10)
	for i := range 10 {
		entries = append(entries, entry{name: fmt.Sprintf("f%02d.go", i), body: "package main"})
	}

	result := walk(t, buildArchive(t, "o-r-sha", entries), limits, acceptAll)
	if len(result.Files) != 3 {
		t.Errorf("kept %d files, want 3", len(result.Files))
	}
	if result.Skipped != 7 {
		t.Errorf("Skipped = %d, want 7", result.Skipped)
	}
	if result.Truncated {
		t.Error("hitting the file cap is not truncation")
	}
}

func TestTheFileCapSamplesTheRepositoryInsteadOfTakingItsFirstCorner(t *testing.T) {
	// The bug this exists for: the cap used to keep the first MaxFiles in tar order, which is
	// roughly alphabetical. On facebook/react that spent all 2,000 inside compiler/ and never
	// reached packages/react-dom, so the resulting document described the compiler and called
	// it React. Sampling keeps the shape, which is what the timeline already does one layer up.
	limits := DefaultLimits()
	limits.MaxFiles = 6

	entries := make([]entry, 0, 60)
	for _, dir := range []string{"aaa", "mmm", "zzz"} {
		for i := range 20 {
			entries = append(entries, entry{
				name: fmt.Sprintf("%s/f%02d.go", dir, i),
				body: "package main",
			})
		}
	}

	result := walk(t, buildArchive(t, "o-r-sha", entries), limits, acceptAll)

	seen := map[string]int{}
	for _, f := range result.Files {
		seen[strings.Split(f.Path, "/")[0]]++
	}
	for _, dir := range []string{"aaa", "mmm", "zzz"} {
		if seen[dir] == 0 {
			t.Errorf("directory %q got no files at all; kept %v", dir, paths(result))
		}
	}
}

func TestBothEndsOfTheRepositorySurviveTheFileCap(t *testing.T) {
	// Keeping the ends is what makes the sample describe the whole repository rather than a
	// window inside it, and it is the property the alphabetical truncation destroyed.
	limits := DefaultLimits()
	limits.MaxFiles = 4

	entries := make([]entry, 0, 40)
	for i := range 40 {
		entries = append(entries, entry{name: fmt.Sprintf("f%02d.go", i), body: "package main"})
	}

	got := paths(walk(t, buildArchive(t, "o-r-sha", entries), limits, acceptAll))
	if len(got) != 4 {
		t.Fatalf("kept %v, want 4 files", got)
	}
	if got[0] != "f00.go" || got[3] != "f39.go" {
		t.Errorf("kept %v, want it to start at f00.go and end at f39.go", got)
	}
}

func TestFilesComeBackInLexicographicOrder(t *testing.T) {
	// docs/features-schema.md: "File traversal order is depth-first, lexicographic by path.
	// Never filesystem order." Tar order is close enough to hide a difference most of the
	// time, which is exactly why it is worth pinning rather than assuming.
	archive := buildArchive(t, "o-r-sha", []entry{
		{name: "src/zebra.go", body: "package main"},
		{name: "src/apple.go", body: "package main"},
		{name: "lib/mango.go", body: "package main"},
	})

	got := paths(walk(t, archive, DefaultLimits(), acceptAll))
	want := []string{"lib/mango.go", "src/apple.go", "src/zebra.go"}
	if len(got) != len(want) {
		t.Fatalf("paths = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("paths = %v, want %v", got, want)
		}
	}
}

func TestTheSampleIsTheSameEveryTime(t *testing.T) {
	// Same commit, same document, forever. A sample chosen by anything but the sorted path
	// list would break that quietly, one file at a time.
	limits := DefaultLimits()
	limits.MaxFiles = 7

	entries := make([]entry, 0, 50)
	for i := range 50 {
		entries = append(entries, entry{name: fmt.Sprintf("d%d/f%02d.go", i%4, i), body: "package main"})
	}
	archive := buildArchive(t, "o-r-sha", entries)

	first := strings.Join(paths(walk(t, archive, limits, acceptAll)), ",")
	for range 5 {
		if got := strings.Join(paths(walk(t, archive, limits, acceptAll)), ","); got != first {
			t.Fatalf("the same archive produced %q then %q", first, got)
		}
	}
}

func TestFileContentsStayWithTheirPaths(t *testing.T) {
	// Two passes means the path is read in one and the body in the other. Pairing them up
	// wrongly would be invisible in every count and wrong in every parse.
	limits := DefaultLimits()
	limits.MaxFiles = 5

	entries := make([]entry, 0, 30)
	for i := range 30 {
		entries = append(entries, entry{
			name: fmt.Sprintf("f%02d.go", i),
			body: fmt.Sprintf("package p%02d", i),
		})
	}

	result := walk(t, buildArchive(t, "o-r-sha", entries), limits, acceptAll)
	if len(result.Files) != 5 {
		t.Fatalf("kept %d files, want 5", len(result.Files))
	}
	for _, f := range result.Files {
		want := "package p" + strings.TrimSuffix(strings.TrimPrefix(f.Path, "f"), ".go")
		if string(f.Data) != want {
			t.Errorf("%s holds %q, want %q", f.Path, f.Data, want)
		}
	}
}

func TestTruncatesRatherThanReadingPastTheArchiveCap(t *testing.T) {
	// The cap is on the compressed stream, because that is the only figure known before
	// decompressing. A gzip bomb is small until it is not.
	entries := make([]entry, 0, 200)
	for i := range 200 {
		entries = append(entries, entry{
			name: fmt.Sprintf("f%03d.go", i),
			// Random-ish so gzip cannot collapse it to nothing.
			body: fmt.Sprintf("package p%d\nvar x = %q\n", i, strings.Repeat("abcdefgh", 64)),
		})
	}
	archive := buildArchive(t, "o-r-sha", entries)

	limits := DefaultLimits()
	limits.MaxArchiveBytes = int64(len(archive) / 4)

	result := walk(t, archive, limits, acceptAll)
	if !result.Truncated {
		t.Fatal("Truncated = false, want true")
	}
	if len(result.Files) >= 200 {
		t.Errorf("read %d files, expected the cap to cut the walk short", len(result.Files))
	}
}

func TestIgnoresEverythingThatIsNotARegularFile(t *testing.T) {
	// A symlink pointing outside the archive is a path traversal waiting to happen.
	archive := buildArchive(t, "o-r-sha", []entry{
		{name: "real.go", body: "package main"},
		{name: "escape.go", body: "../../../../etc/passwd", typ: tar.TypeSymlink},
		{name: "somedir", typ: tar.TypeDir},
	})

	result := walk(t, archive, DefaultLimits(), acceptAll)
	if got := paths(result); len(got) != 1 || got[0] != "real.go" {
		t.Errorf("kept %v, want only real.go", got)
	}
	// Neither is a file, so neither counts as a file that was skipped.
	if result.Skipped != 0 {
		t.Errorf("Skipped = %d, want 0", result.Skipped)
	}
}

func TestHonoursTheWallClock(t *testing.T) {
	archive := buildArchive(t, "o-r-sha", []entry{{name: "a.go", body: "package main"}})

	ctx, cancel := context.WithTimeout(context.Background(), time.Nanosecond)
	defer cancel()
	time.Sleep(time.Millisecond)

	if _, err := Walk(ctx, bytes.NewReader(archive), DefaultLimits(), acceptAll); err == nil {
		t.Fatal("walked to completion with an expired context")
	}
}

func TestSkipRules(t *testing.T) {
	for _, name := range []string{
		"node_modules/x.js",
		"a/node_modules/b/x.js",
		"vendor/x.go",
		"dist/x.js",
		"build/x.js",
		"testdata/x.go",
		"a/b.min.js",
		"package-lock.json",
		"a/YARN.LOCK",
	} {
		if !Skip(name) {
			t.Errorf("Skip(%q) = false, want true", name)
		}
	}

	for _, name := range []string{
		"src/app.ts",
		"packages/react/index.js",
		// "building" merely starts with "build"; only whole segments count.
		"building/x.go",
		"src/minify.ts",
	} {
		if Skip(name) {
			t.Errorf("Skip(%q) = true, want false", name)
		}
	}
}

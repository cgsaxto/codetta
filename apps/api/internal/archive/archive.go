// Package archive walks a GitHub tarball and applies every limit in
// docs/features-schema.md.
//
// The governing sentence from that document: "Exceeding a limit is a normal outcome, not an
// error: parse what fits, report the rest in totals.filesSkipped, and return a valid
// document." So nothing here fails because a repository is large. It stops, counts what it
// left behind, and hands back what it got.
package archive

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"path"
	"sort"
	"strings"
)

// Limits are the caps from docs/features-schema.md. They are not tuning knobs: an unbounded
// fetch is a denial-of-service vector, and these are the boundary.
type Limits struct {
	// MaxArchiveBytes is measured on the compressed stream, because that is the only figure
	// known before decompressing — a gzip bomb is small until it is not.
	MaxArchiveBytes int64
	MaxFiles        int
	MaxFileBytes    int64
}

func DefaultLimits() Limits {
	return Limits{
		MaxArchiveBytes: 100 << 20, // 100 MB
		MaxFiles:        2000,
		MaxFileBytes:    512 << 10, // 512 KB
	}
}

type File struct {
	// Path is relative to the repository root, with GitHub's wrapper directory stripped.
	Path string
	Data []byte
}

type Result struct {
	// Files are in lexicographic order, which is the order docs/features-schema.md requires
	// and which the sampling below depends on.
	Files []File
	// Skipped counts files this walk saw and rejected: vendored, generated, oversized,
	// unwanted by the caller, or thinned out by the file cap. It feeds totals.filesSkipped.
	Skipped int
	// Truncated records that the archive cap cut the walk short. The schema has nowhere to
	// put this, so it only shows up as a smaller filesScanned — but the caller may want to
	// log it, because a truncated repository is a different thing from a small one.
	Truncated bool
}

// Directory names that never contain a repository's own source.
var skippedDirs = map[string]bool{
	"node_modules": true,
	"vendor":       true,
	"dist":         true,
	"build":        true,
	"testdata":     true,
}

// Generated files that are source by extension and noise by nature.
var skippedFiles = map[string]bool{
	"package-lock.json": true,
	"pnpm-lock.yaml":    true,
	"yarn.lock":         true,
	"go.sum":            true,
	"cargo.lock":        true,
	"poetry.lock":       true,
	"composer.lock":     true,
	"gemfile.lock":      true,
}

// Skip reports whether a path is excluded by docs/features-schema.md regardless of what the
// caller is looking for.
func Skip(name string) bool {
	for _, segment := range strings.Split(name, "/") {
		if skippedDirs[segment] {
			return true
		}
	}

	base := strings.ToLower(path.Base(name))
	if skippedFiles[base] {
		return true
	}
	// Minified output: parsing it would report one enormous function on one line.
	return strings.Contains(base, ".min.")
}

// stripRoot removes the wrapper directory GitHub puts around a tarball, which is named
// owner-repo-sha and is not part of anybody's repository.
func stripRoot(name string) string {
	name = strings.TrimPrefix(name, "./")
	if i := strings.Index(name, "/"); i >= 0 {
		return name[i+1:]
	}
	return ""
}

// cutShort reports whether an error is what an archive stopped at MaxArchiveBytes looks like
// from inside gzip and tar, rather than a real decoding failure.
func cutShort(err error) bool {
	return errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, gzip.ErrChecksum)
}

// candidate is one file that survived every per-file rule in the first pass. Only its path
// is known at that point — the body is still in the archive — which is why there are two.
type candidate struct {
	path string
}

// Walk reads a gzipped tar and returns the files that survive every limit.
//
// accept decides which paths are worth keeping — it is supplied by the caller because this
// package has no opinion about languages, and because the file cap has to apply to files
// that will actually be parsed rather than to every PNG in the repository.
//
// The archive is buffered and read twice, because the file cap is applied by sampling and
// sampling cannot choose anything until it knows how many candidates there are. Streaming
// could only ever keep the first MaxFiles in tar order, which is roughly alphabetical: that
// spent facebook/react's entire 2,000-file budget inside compiler/ and never reached
// packages/react-dom at all, so "react" came out sounding like its compiler subproject. It
// is the same mistake the timeline already avoids by sampling instead of truncating.
//
// The buffer is bounded by MaxArchiveBytes, which is the cap that already existed for
// exactly this class of reason, and it is dwarfed by the file data the walk returns anyway.
func Walk(
	ctx context.Context,
	r io.Reader,
	limits Limits,
	accept func(path string) bool,
) (Result, error) {
	raw, truncated, err := buffer(r, limits.MaxArchiveBytes)
	if err != nil {
		return Result{}, fmt.Errorf("reading archive: %w", err)
	}

	candidates, skipped, cut, err := scan(ctx, raw, limits, accept)
	if err != nil {
		return Result{}, err
	}
	truncated = truncated || cut

	selected := choose(candidates, limits.MaxFiles)
	// Everything the cap thinned out is still a file this walk saw and did not parse.
	skipped += len(candidates) - len(selected)

	files, err := read(ctx, raw, selected)
	if err != nil {
		return Result{}, err
	}

	return Result{Files: files, Skipped: skipped, Truncated: truncated}, nil
}

// buffer reads at most limit bytes and reports whether the stream had more.
func buffer(r io.Reader, limit int64) ([]byte, bool, error) {
	// One byte past the limit, so an archive that lands exactly on the cap is not mistaken
	// for a truncated one.
	raw, err := io.ReadAll(io.LimitReader(r, limit+1))
	if err != nil {
		return nil, false, err
	}
	if int64(len(raw)) > limit {
		return raw[:limit], true, nil
	}
	return raw, false, nil
}

func open(raw []byte) (*tar.Reader, io.Closer, error) {
	gz, err := gzip.NewReader(bytes.NewReader(raw))
	if err != nil {
		return nil, nil, fmt.Errorf("opening archive: %w", err)
	}
	return tar.NewReader(gz), gz, nil
}

// scan is the first pass: it reads headers only and never touches a file body, so the cost
// of running the archive twice is one decompression rather than two full reads.
func scan(
	ctx context.Context,
	raw []byte,
	limits Limits,
	accept func(path string) bool,
) (candidates []candidate, skipped int, truncated bool, err error) {
	reader, closer, err := open(raw)
	if err != nil {
		return nil, 0, false, err
	}
	defer closer.Close()

	for {
		// The wall clock is a hard limit, and a large archive is exactly where it runs out.
		if err := ctx.Err(); err != nil {
			return nil, 0, true, err
		}

		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			return candidates, skipped, false, nil
		}
		if err != nil {
			if cutShort(err) {
				return candidates, skipped, true, nil
			}
			return nil, 0, false, fmt.Errorf("reading archive: %w", err)
		}

		// Regular files only. A symlink pointing outside the archive is a path traversal
		// waiting to happen, and directories carry no source.
		if header.Typeflag != tar.TypeReg {
			continue
		}

		name := stripRoot(header.Name)
		if name == "" || Skip(name) {
			skipped++
			continue
		}
		if !accept(name) {
			// Unsupported languages count toward filesSkipped, per the schema doc.
			skipped++
			continue
		}
		if header.Size > limits.MaxFileBytes {
			skipped++
			continue
		}

		candidates = append(candidates, candidate{path: name})
	}
}

// choose sorts the candidates and thins them to the file cap, spread evenly and keeping both
// ends. This mirrors aggregate.sample deliberately: same rule, same reason, applied once to
// what gets parsed and once to what reaches the timeline.
func choose(candidates []candidate, limit int) []candidate {
	sort.Slice(candidates, func(i, j int) bool { return candidates[i].path < candidates[j].path })

	if limit <= 0 {
		return nil
	}
	if len(candidates) <= limit {
		return candidates
	}
	if limit == 1 {
		return candidates[:1]
	}

	out := make([]candidate, 0, limit)
	for i := range limit {
		index := int(math.Round(float64(i) * float64(len(candidates)-1) / float64(limit-1)))
		out = append(out, candidates[index])
	}
	return out
}

// read is the second pass: it reads the bodies of the selected files and nothing else.
func read(ctx context.Context, raw []byte, selected []candidate) ([]File, error) {
	if len(selected) == 0 {
		return nil, nil
	}

	// A count rather than a set, so a tarball that somehow lists a path twice yields two
	// files instead of a silent hole.
	wanted := make(map[string]int, len(selected))
	for _, c := range selected {
		wanted[c.path]++
	}

	reader, closer, err := open(raw)
	if err != nil {
		return nil, err
	}
	defer closer.Close()

	files := make([]File, 0, len(selected))
	for len(files) < len(selected) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}

		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			if cutShort(err) {
				break
			}
			return nil, fmt.Errorf("reading archive: %w", err)
		}
		if header.Typeflag != tar.TypeReg {
			continue
		}

		name := stripRoot(header.Name)
		if wanted[name] == 0 {
			continue
		}
		wanted[name]--

		data := make([]byte, header.Size)
		if _, err := io.ReadFull(reader, data); err != nil {
			if cutShort(err) || errors.Is(err, io.EOF) {
				break
			}
			return nil, fmt.Errorf("reading %s: %w", name, err)
		}
		files = append(files, File{Path: name, Data: data})
	}

	// The tar is in its own order; the contract is lexicographic.
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	return files, nil
}

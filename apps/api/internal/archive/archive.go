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
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"path"
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
	Files []File
	// Skipped counts files this walk saw and rejected: vendored, generated, oversized, or
	// unwanted by the caller. It feeds totals.filesSkipped.
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

// errTooLarge is returned by the capped reader and unwrapped by Walk. It is not exported
// because callers never see it: exceeding the archive cap is truncation, not failure.
var errTooLarge = errors.New("archive exceeded its size cap")

type cappedReader struct {
	inner     io.Reader
	remaining int64
}

func (c *cappedReader) Read(p []byte) (int, error) {
	if c.remaining <= 0 {
		return 0, errTooLarge
	}
	if int64(len(p)) > c.remaining {
		p = p[:c.remaining]
	}
	n, err := c.inner.Read(p)
	c.remaining -= int64(n)
	return n, err
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

// Walk reads a gzipped tar and returns the files that survive every limit.
//
// accept decides which paths are worth keeping — it is supplied by the caller because this
// package has no opinion about languages, and because the file cap has to apply to files
// that will actually be parsed rather than to every PNG in the repository.
func Walk(
	ctx context.Context,
	r io.Reader,
	limits Limits,
	accept func(path string) bool,
) (Result, error) {
	gz, err := gzip.NewReader(&cappedReader{inner: r, remaining: limits.MaxArchiveBytes})
	if err != nil {
		return Result{}, fmt.Errorf("opening archive: %w", err)
	}
	defer gz.Close()

	var result Result
	reader := tar.NewReader(gz)

	for {
		// The wall clock is a hard limit, and a large archive is exactly where it runs out.
		if err := ctx.Err(); err != nil {
			result.Truncated = true
			return result, err
		}

		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			return result, nil
		}
		if err != nil {
			// A cut-off stream is what hitting the archive cap looks like from up here.
			if errors.Is(err, errTooLarge) || errors.Is(err, io.ErrUnexpectedEOF) {
				result.Truncated = true
				return result, nil
			}
			return result, fmt.Errorf("reading archive: %w", err)
		}

		// Regular files only. A symlink pointing outside the archive is a path traversal
		// waiting to happen, and directories carry no source.
		if header.Typeflag != tar.TypeReg {
			continue
		}

		name := stripRoot(header.Name)
		if name == "" || Skip(name) {
			result.Skipped++
			continue
		}
		if !accept(name) {
			// Unsupported languages count toward filesSkipped, per the schema doc.
			result.Skipped++
			continue
		}
		if header.Size > limits.MaxFileBytes {
			result.Skipped++
			continue
		}
		if len(result.Files) >= limits.MaxFiles {
			result.Skipped++
			continue
		}

		data := make([]byte, header.Size)
		if _, err := io.ReadFull(reader, data); err != nil {
			if errors.Is(err, errTooLarge) || errors.Is(err, io.ErrUnexpectedEOF) {
				result.Truncated = true
				return result, nil
			}
			return result, fmt.Errorf("reading %s: %w", name, err)
		}

		result.Files = append(result.Files, File{Path: name, Data: data})
	}
}

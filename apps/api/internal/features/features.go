// Package features is the pipeline: a tarball goes in, a RepoFeatures document comes out.
//
// It is the only place the three halves of the service meet, and it holds no logic of its
// own — the caps live in archive, the language knowledge lives in parse, and the arithmetic
// lives in aggregate. What it contributes is the order they run in.
package features

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"codetta.dev/api/internal/aggregate"
	"codetta.dev/api/internal/archive"
	"codetta.dev/api/internal/github"
	"codetta.dev/api/internal/parse"
	"codetta.dev/schema"
)

// ErrNoSupportedFiles is the 422 from docs/features-schema.md. It is a normal outcome for a
// repository written in something we do not parse, not a failure of this service.
var ErrNoSupportedFiles = errors.New("no files in a supported language")

// NoSupportedFilesMessage names the languages we do support, because a bare "unsupported"
// leaves the reader guessing at what would have worked.
func NoSupportedFilesMessage() string {
	return fmt.Sprintf(
		"this repository has no files in a language Codetta can read. Supported: %s",
		strings.Join(parse.Names(), ", "),
	)
}

// FromTarball walks the archive, counts what it finds, and aggregates the result.
func FromTarball(
	ctx context.Context,
	repo github.Repo,
	tarball io.Reader,
	fetchedAt time.Time,
) (schema.RepoFeatures, error) {
	// parse.Supported is what keeps the 2,000-file cap counting files that will actually be
	// parsed, rather than being spent on a repository's images.
	walked, err := archive.Walk(ctx, tarball, archive.DefaultLimits(), parse.Supported)
	if err != nil {
		return schema.RepoFeatures{}, fmt.Errorf("walking archive: %w", err)
	}

	// One counter, used in sequence. Parsing in parallel is allowed — aggregate.Build sorts
	// its input precisely so that it can be — but it would mean one counter per goroutine,
	// because tree-sitter parsers are not safe to share.
	counter := parse.NewCounter()
	defer counter.Close()

	stats := make([]parse.FileStats, 0, len(walked.Files))
	skipped := walked.Skipped

	for _, file := range walked.Files {
		if err := ctx.Err(); err != nil {
			return schema.RepoFeatures{}, err
		}
		counted, ok := counter.Count(file.Path, file.Data)
		if !ok {
			// The walker's predicate already filtered by extension, so this is a file whose
			// grammar refused to load. Counting it as skipped keeps the totals honest.
			skipped++
			continue
		}
		stats = append(stats, counted)
	}

	if len(stats) == 0 {
		return schema.RepoFeatures{}, ErrNoSupportedFiles
	}

	return aggregate.Build(aggregate.Input{
		Owner:           repo.Owner,
		Name:            repo.Name,
		Ref:             repo.Ref,
		CommitSHA:       repo.CommitSHA,
		PrimaryLanguage: repo.PrimaryLanguage,
		Stars:           repo.Stars,
		Files:           stats,
		Skipped:         skipped,
		FetchedAt:       fetchedAt,
	}), nil
}

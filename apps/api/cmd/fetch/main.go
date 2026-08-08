// Command fetch turns one repository into a RepoFeatures document on disk.
//
// It exists for the gallery: Phase 3 pre-renders famous repositories and commits their
// documents to fixtures/, and that has to be a deliberate, reviewable act rather than
// something a server does on a timer. It is also the fastest way to see what a real
// repository actually produces, which a synthetic tarball cannot tell you.
//
//	go run codetta.dev/api/cmd/fetch -o fixtures/gallery/vuejs-core.json vuejs/core
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"codetta.dev/api/internal/config"
	"codetta.dev/api/internal/features"
	"codetta.dev/api/internal/github"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run() error {
	ref := flag.String("ref", "", "branch, tag or sha; defaults to the repository's default branch")
	out := flag.String("o", "", "write here instead of stdout")
	// Defaults to the production budget so this reports what a real request would do,
	// rather than quietly succeeding on time a served request would not have.
	timeout := flag.Duration("timeout", github.DefaultTimeout, "wall-clock budget")
	flag.Parse()

	if flag.NArg() != 1 {
		return errors.New("usage: fetch [flags] owner/repo")
	}
	owner, name, ok := strings.Cut(flag.Arg(0), "/")
	if !ok || owner == "" || name == "" {
		return fmt.Errorf("%q is not owner/repo", flag.Arg(0))
	}

	cfg, err := config.Load()
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()

	client := github.New(cfg.GitHubToken)

	started := time.Now()
	repo, err := client.Resolve(ctx, owner, name, *ref)
	if err != nil {
		return fmt.Errorf("resolving %s/%s: %w", owner, name, err)
	}
	fmt.Fprintf(os.Stderr, "%s/%s@%s -> %s (%s, %d stars) in %s\n",
		repo.Owner, repo.Name, repo.Ref, repo.CommitSHA[:8],
		repo.PrimaryLanguage, repo.Stars, time.Since(started).Round(time.Millisecond))

	tarball, err := client.Tarball(ctx, repo.Owner, repo.Name, repo.CommitSHA)
	if err != nil {
		return fmt.Errorf("fetching tarball: %w", err)
	}
	defer tarball.Close()

	document, err := features.FromTarball(ctx, repo, tarball, time.Now())
	if err != nil {
		if errors.Is(err, features.ErrNoSupportedFiles) {
			return errors.New(features.NoSupportedFilesMessage())
		}
		return err
	}

	encoded, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		return fmt.Errorf("encoding: %w", err)
	}
	encoded = append(encoded, '\n')

	if *out == "" {
		_, err = os.Stdout.Write(encoded)
	} else {
		if err := os.MkdirAll(filepath.Dir(*out), 0o755); err != nil {
			return err
		}
		err = os.WriteFile(*out, encoded, 0o644)
	}
	if err != nil {
		return err
	}

	summarise(document.Totals.FilesScanned, document.Totals.FilesSkipped,
		document.Totals.LinesOfCode, len(document.Modules), len(document.Timeline),
		time.Since(started), *out)
	return nil
}

func summarise(scanned, skipped, lines, modules, timeline int, elapsed time.Duration, out string) {
	where := "stdout"
	if out != "" {
		where = out
	}
	fmt.Fprintf(os.Stderr,
		"parsed %d files (%d skipped), %d lines, %d modules, %d timeline entries in %s -> %s\n",
		scanned, skipped, lines, modules, timeline, elapsed.Round(time.Millisecond), where)
}

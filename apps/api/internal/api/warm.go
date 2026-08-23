package api

import (
	"context"
	"time"

	"codetta.dev/api/internal/cache"
)

/*
Warming the cache for the repositories the front page shows.

Worth being exact about what this buys, because the obvious reading is wrong. The eight
gallery tiles are committed documents inside the web bundle: playing one costs this service
nothing and would survive with the API switched off entirely. What a spike actually produces
is people *pasting* those same eight repositories into the box, and that is a full fetch and
parse each — twenty seconds of work and three GitHub requests, repeated per visitor until one
of them finishes and fills the cache.

So the warm is not about the gallery. It is about the first hundred people to type
facebook/react, and it turns their request into a cache read.

It is deliberately not a background refresh. Everything here is keyed by commit SHA, HEAD
moves, and a warm that ran hourly would spend the token budget chasing commits nobody has
asked for.
*/

// RepoRef is a repository to warm. Deliberately not site.Card: the list comes from the
// manifest today, and this package should not learn what an unfurl is to accept one.
type RepoRef struct {
	Owner string
	Name  string
}

/*
WarmGallery loads each repository once, skipping whatever the cache already holds.

Sequential, and that is not laziness. Eight tarballs in parallel is eight simultaneous
downloads and eight tree-sitter parses on a box that has just started and may be serving its
first requests; the warm is the least urgent work this process will ever do, so it takes the
slow lane.

Never returns an error. A warm that failed is a slower first visitor, and a boot that failed
because a warm did is strictly worse than no warm at all.
*/
func (deps Deps) WarmGallery(ctx context.Context, repos []RepoRef) {
	if len(repos) == 0 {
		return
	}

	// Warming a cache that forgets everything immediately is pure cost: eight parses and
	// twenty-four GitHub requests spent on entries nothing will ever read back.
	if _, missing := deps.Cache.(cache.Nop); missing || deps.Cache == nil {
		deps.Logger.Info("skipping the gallery warm, there is no cache to warm")
		return
	}

	started := time.Now()
	warmed, held, failed := 0, 0, 0

	// Announced, and then one line each. A warm takes minutes and used to say nothing until
	// it was over, which is indistinguishable from a warm that never started — and the first
	// question anybody asks about a background job is whether it is running.
	deps.Logger.Info("warming the gallery", "repos", len(repos))

	for _, repo := range repos {
		if ctx.Err() != nil {
			deps.Logger.Info("gallery warm interrupted", "done", warmed+held, "of", len(repos))
			return
		}

		begun := time.Now()
		each, cancel := context.WithTimeout(ctx, deps.Budget)
		_, cached, err := deps.Load(each, repo.Owner, repo.Name, "")
		cancel()

		switch {
		case err != nil:
			failed++
			// Warn, not error. A repository that has been renamed or a blip at GitHub costs
			// one visitor a slow first play, and nothing else in this process cares.
			deps.Logger.Warn("could not warm",
				"repo", repo.Owner+"/"+repo.Name, "step", stepOf(err), "error", err)
		case cached:
			held++
			deps.Logger.Info("already warm", "repo", repo.Owner+"/"+repo.Name)
		default:
			warmed++
			deps.Logger.Info("warmed", "repo", repo.Owner+"/"+repo.Name,
				"took", time.Since(begun).Round(time.Second))
		}
	}

	deps.Logger.Info("gallery warm finished",
		"parsed", warmed, "already cached", held, "failed", failed,
		"took", time.Since(started).Round(time.Second))
}

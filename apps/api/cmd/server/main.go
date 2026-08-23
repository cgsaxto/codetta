// Command server is the Codetta API.
//
// It knows nothing about music. Its whole job is to turn a repository reference into a
// RepoFeatures document, and the only thing it shares with apps/web is that document.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"codetta.dev/api/internal/api"
	"codetta.dev/api/internal/cache"
	"codetta.dev/api/internal/config"
	"codetta.dev/api/internal/github"
	"codetta.dev/api/internal/site"
)

func main() {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))

	if err := run(logger); err != nil {
		// A missing token is a setup problem, not a crash. Say what to do and leave quietly.
		if errors.Is(err, config.ErrMissingToken) {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		logger.Error("server stopped", "error", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	// Constructed here rather than per-request so connections are reused, and so a bad token
	// is a startup concern rather than a surprise on the first repository.
	client := github.New(cfg.GitHubToken)

	// Never pings. A Redis that is down now and up later starts working on its own, which is
	// the difference between a cache and a dependency.
	store, err := cache.New(cfg.RedisURL, logger)
	if err != nil {
		return fmt.Errorf("configuring the cache: %w", err)
	}

	// Fails the boot rather than the unfurl. A missing manifest or an index without its
	// marker is a broken build, and the only person who would notice it later is whoever
	// shared a link that came back generic.
	var pages *site.Site
	if cfg.SiteDir != "" {
		pages, err = site.Handler(os.DirFS(cfg.SiteDir))
		if err != nil {
			return fmt.Errorf("serving %s: %w", cfg.SiteDir, err)
		}
		logger.Info("serving the web app", "dir", cfg.SiteDir)
	}

	caller, global := api.DefaultLimits()
	deps := api.Deps{
		GitHub:     client,
		Cache:      store,
		Logger:     logger,
		Caller:     caller,
		Global:     global,
		TrustProxy: cfg.TrustProxy,
	}
	if pages != nil {
		// Typed nil is why this is a branch rather than an assignment: a nil *site.Site in an
		// http.Handler field is not a nil interface, and the router would register it and then
		// panic on the first request for anything that is not an endpoint.
		deps.Site = pages
	}

	server := &http.Server{
		Addr:    cfg.Addr,
		Handler: api.Handler(deps),
		// Comfortably past the 25 s fetch budget, so a slow repository is cut off by its own
		// deadline with a friendly message rather than by the socket closing underneath it.
		ReadHeaderTimeout: 5 * time.Second,
		WriteTimeout:      40 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	errs := make(chan error, 1)
	go func() {
		logger.Info("listening", "addr", cfg.Addr)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errs <- err
		}
	}()

	// After the listener is up, never before it. The warm is the least urgent work this
	// process does and it takes minutes; a boot that waited for it would fail every health
	// check it was given in the meantime and be restarted into doing it again.
	if cfg.WarmGallery && pages != nil {
		go func() {
			repos := make([]api.RepoRef, 0, len(pages.Cards()))
			for _, card := range pages.Cards() {
				repos = append(repos, api.RepoRef{Owner: card.Owner, Name: card.Name})
			}
			// api.Handler fills the Deps defaults; this copy has not been through it.
			warm := deps
			warm.Budget = github.DefaultTimeout
			warm.WarmGallery(ctx, repos)
		}()
	}

	select {
	case err := <-errs:
		return err
	case <-ctx.Done():
		logger.Info("shutting down")
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return server.Shutdown(shutdown)
	}
}

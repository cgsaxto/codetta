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

	"codetta.dev/api/internal/cache"
	"codetta.dev/api/internal/config"
	"codetta.dev/api/internal/github"
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
	_ = github.New(cfg.GitHubToken)

	// Never pings. A Redis that is down now and up later starts working on its own, which is
	// the difference between a cache and a dependency.
	features, err := cache.New(cfg.RedisURL, logger)
	if err != nil {
		return fmt.Errorf("configuring the cache: %w", err)
	}
	_ = features

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})

	server := &http.Server{
		Addr:    cfg.Addr,
		Handler: mux,
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

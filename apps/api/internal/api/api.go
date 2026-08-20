// Package api is the HTTP surface: one endpoint that turns a repository reference into a
// RepoFeatures document.
//
// It holds no logic of its own beyond the order things happen in and what each failure looks
// like from outside. The caps live in archive, the language knowledge in parse, the
// arithmetic in aggregate — and none of them knows it is being served over HTTP.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"time"

	"codetta.dev/api/internal/cache"
	"codetta.dev/api/internal/features"
	"codetta.dev/api/internal/github"
)

// Deps is what the handler cannot build for itself. Constructed once at startup so
// connections are reused and a bad token is a boot-time problem rather than a surprise on
// the first repository.
type Deps struct {
	GitHub *github.Client
	Cache  cache.Cache
	Logger *slog.Logger
	// Budget is the wall clock from docs/features-schema.md. Zero means the default.
	Budget time.Duration
	// Site serves the built web app, if this deployment carries one. Nil means API only,
	// which is what `make api-dev` runs against a Vite dev server.
	Site http.Handler
}

type errorBody struct {
	Error string `json:"error"`
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	// The status line is already sent, so a failure here can only be logged by the caller's
	// server. Encoding a document that was just built in memory does not realistically fail.
	_ = json.NewEncoder(w).Encode(body)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, errorBody{Error: message})
}

// Handler returns the router. Every route is a GET; nothing here mutates anything.
func Handler(deps Deps) http.Handler {
	if deps.Budget == 0 {
		deps.Budget = github.DefaultTimeout
	}
	if deps.Logger == nil {
		deps.Logger = slog.New(slog.DiscardHandler)
	}
	if deps.Cache == nil {
		deps.Cache = cache.Nop{}
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /v1/features/{owner}/{name}", deps.featuresHandler)

	// Registered last and matching everything left over, so the API's own routes always win.
	// A repository called `v1` cannot shadow the endpoint, whatever else it does.
	if deps.Site != nil {
		mux.Handle("/", deps.Site)
	}

	return withCORS(mux)
}

/*
withCORS opens the API to any origin.

Safe here, and not a shortcut: this service takes no credentials, sets no cookies, and every
route is a GET that reads public data. The one secret it holds is the GitHub token, which
never leaves the process — docs/features-schema.md is explicit that the browser never talks
to GitHub and no token crosses the wire. So there is nothing an origin could abuse that it
could not equally well fetch itself.

It also means apps/web can be served from anywhere without the API needing to know where.
*/
func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		w.Header().Set("Access-Control-Max-Age", "86400")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (deps Deps) featuresHandler(w http.ResponseWriter, r *http.Request) {
	// One budget for the whole exchange, shared by resolving, downloading and parsing. The
	// client's own disconnect cancels it too, so an abandoned request stops costing anything.
	ctx, cancel := context.WithTimeout(r.Context(), deps.Budget)
	defer cancel()

	owner := r.PathValue("owner")
	name := r.PathValue("name")
	ref := r.URL.Query().Get("ref")

	started := time.Now()

	// The ref is resolved before anything else because the SHA is the cache key and the
	// seed. Branches move; the music must not.
	repo, err := deps.GitHub.Resolve(ctx, owner, name, ref)
	if err != nil {
		deps.fail(w, r, "resolving", owner, name, err)
		return
	}

	if document, found := deps.Cache.Get(ctx, repo.CommitSHA); found {
		deps.Logger.Info("served from cache",
			"repo", owner+"/"+name, "sha", repo.CommitSHA[:8], "took", time.Since(started))
		writeJSON(w, http.StatusOK, document)
		return
	}

	tarball, err := deps.GitHub.Tarball(ctx, repo.Owner, repo.Name, repo.CommitSHA)
	if err != nil {
		deps.fail(w, r, "fetching the archive", owner, name, err)
		return
	}
	defer tarball.Close()

	document, err := features.FromTarball(ctx, repo, tarball, time.Now())
	if err != nil {
		deps.fail(w, r, "parsing", owner, name, err)
		return
	}

	deps.Cache.Put(ctx, repo.CommitSHA, document)
	deps.Logger.Info("parsed",
		"repo", owner+"/"+name, "sha", repo.CommitSHA[:8],
		"scanned", document.Totals.FilesScanned, "skipped", document.Totals.FilesSkipped,
		"took", time.Since(started))

	writeJSON(w, http.StatusOK, document)
}

/*
fail turns an error from anywhere in the pipeline into a status and a sentence.

The sentences are for a person looking at a repository that did not play, so they say what
happened and, where there is one, what would have worked. The distinction that matters is
whose problem it is: a repository we cannot read is the visitor's to fix by picking another,
a spent rate limit or a rejected token is ours and must not be dressed up as theirs.
*/
func (deps Deps) fail(w http.ResponseWriter, r *http.Request, stage, owner, name string, err error) {
	repo := owner + "/" + name

	switch {
	case errors.Is(err, github.ErrNotFound):
		writeError(w, http.StatusNotFound,
			"no repository at "+repo+". Private repositories look the same as missing ones "+
				"from here, and Codetta only reads public ones.")

	case errors.Is(err, features.ErrNoSupportedFiles):
		// The 422 from docs/features-schema.md, and the reason it names the four languages:
		// a bare "unsupported" leaves the reader guessing at what would have worked.
		writeError(w, http.StatusUnprocessableEntity, features.NoSupportedFilesMessage())

	case errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled):
		// The client going away lands here too. Nobody reads that response, and writing it
		// costs nothing, so it is not worth a branch of its own.
		deps.Logger.Warn("gave up", "repo", repo, "stage", stage, "error", err)
		writeError(w, http.StatusGatewayTimeout,
			repo+" took longer than Codetta waits. Very large repositories can do this — "+
				"try again, or try a smaller one.")

	case errors.Is(err, github.ErrRateLimited):
		// Ours, not theirs. GitHub's hourly budget is spent for everyone until it resets.
		deps.Logger.Error("github rate limit exhausted", "repo", repo, "error", err)
		w.Header().Set("Retry-After", "300")
		writeError(w, http.StatusServiceUnavailable,
			"Codetta has run out of GitHub requests for the moment. Try again shortly.")

	case errors.Is(err, github.ErrUnauthorized):
		// A misconfigured or expired token. Never described to the caller as their mistake,
		// and never with any detail that hints at the credential.
		deps.Logger.Error("github rejected the token", "repo", repo, "stage", stage)
		writeError(w, http.StatusInternalServerError,
			"Codetta cannot talk to GitHub right now. This one is on us.")

	default:
		// A *url.Error means the exchange itself failed — DNS, a refused connection, a
		// connection dropped mid-body — rather than GitHub answering with a status. It is
		// upstream and it is transient, which makes it a 502 with advice rather than a 500
		// with none. Worth separating: this is what an ordinary network blip looks like from
		// here, and telling someone "something went wrong" when the fix is to press the
		// button again is the difference between a bug report and a retry.
		var transport *url.Error
		if errors.As(err, &transport) {
			deps.Logger.Warn("could not reach github", "repo", repo, "stage", stage, "error", err)
			writeError(w, http.StatusBadGateway,
				"Codetta could not reach GitHub just then. Try again.")
			return
		}

		deps.Logger.Error("request failed", "repo", repo, "stage", stage, "error", err)
		writeError(w, http.StatusInternalServerError, "something went wrong "+stage+" "+repo+".")
	}
}

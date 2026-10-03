// Package api is the HTTP surface: one endpoint that turns a repository reference into a
// RepoFeatures document, and one that turns a username into the repository to ask about.
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
	"strconv"
	"time"

	"codetta.dev/api/internal/cache"
	"codetta.dev/api/internal/features"
	"codetta.dev/api/internal/github"
	"codetta.dev/api/internal/ratelimit"
	"codetta.dev/schema"
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
	// Caller and Global bound how fast the two expensive routes may be asked for work. Nil
	// means no limit, which is what tests and `make api-dev` run with — a limiter in a test
	// is a source of flakiness in exchange for nothing.
	Caller *ratelimit.Limiter
	Global *ratelimit.Limiter
	// TrustProxy decides whether X-Forwarded-For is evidence. See ratelimit.ClientKey: it
	// has to be a deployment decision, because getting it wrong in either direction breaks
	// the limiter completely rather than partially.
	TrustProxy bool
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
	// Limited, and only these two. /healthz is what a platform calls to decide whether this
	// process is alive, and rate-limiting the question "are you alive" gets the answer wrong;
	// the site's static files cost nothing that GitHub meters.
	// The same-origin web app calls /api/v1; direct API clients still use /v1. Vite strips
	// /api in development, but the production process must serve both without that proxy.
	for _, prefix := range []string{"", "/api"} {
		mux.HandleFunc("GET "+prefix+"/v1/features/{owner}/{name}", deps.limited(deps.featuresHandler))
		mux.HandleFunc("GET "+prefix+"/v1/users/{login}", deps.limited(deps.userHandler))
	}

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

/*
limited refuses work this service cannot afford to do.

Two limits in a deliberate order. The caller's own allowance is checked first, so that one
script cannot spend the shared budget on its way to being told no — checking the global one
first would let exactly the caller this is meant to stop take everybody else's turn.

The statuses differ because whose problem it is differs, the same distinction fail() makes.
429 is "you are going faster than we serve"; 503 is "everyone is, and that is ours".
*/
func (deps Deps) limited(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Caller != nil {
			if ok, wait := deps.Caller.Allow(ratelimit.ClientKey(r, deps.TrustProxy)); !ok {
				retryAfter(w, wait)
				writeError(w, http.StatusTooManyRequests,
					"that is faster than Codetta reads. Each repository is fetched and parsed "+
						"from scratch — give it a moment and try again.")
				return
			}
		}

		// One bucket for every caller together, because a thousand people arriving from a
		// front page are a thousand addresses and no per-caller limit sees them as related.
		// What they share is GitHub's hourly budget, and this is the only thing that bounds it.
		if deps.Global != nil {
			if ok, wait := deps.Global.Allow("everyone"); !ok {
				retryAfter(w, wait)
				deps.Logger.Warn("shedding load", "path", r.URL.Path, "retryAfter", wait)
				writeError(w, http.StatusServiceUnavailable,
					"Codetta is reading as fast as it can just now. Try again shortly — the "+
						"eight on the front page play without waiting for anything.")
				return
			}
		}

		next(w, r)
	}
}

// retryAfter states the wait in the header the client already knows how to read. A number
// someone can wait out is the difference between a retry and a refresh loop.
func retryAfter(w http.ResponseWriter, wait time.Duration) {
	seconds := int(wait.Seconds())
	if wait > 0 && seconds < 1 {
		seconds = 1
	}
	w.Header().Set("Retry-After", strconv.Itoa(seconds))
}

func (deps Deps) featuresHandler(w http.ResponseWriter, r *http.Request) {
	// One budget for the whole exchange, shared by resolving, downloading and parsing. The
	// client's own disconnect cancels it too, so an abandoned request stops costing anything.
	ctx, cancel := context.WithTimeout(r.Context(), deps.Budget)
	defer cancel()

	owner := r.PathValue("owner")
	name := r.PathValue("name")
	started := time.Now()

	document, cached, err := deps.Load(ctx, owner, name, r.URL.Query().Get("ref"))
	if err != nil {
		deps.fail(w, owner, name, err)
		return
	}

	if cached {
		deps.Logger.Info("served from cache",
			"repo", owner+"/"+name, "took", time.Since(started))
	} else {
		deps.Logger.Info("parsed", "repo", owner+"/"+name,
			"scanned", document.Totals.FilesScanned, "skipped", document.Totals.FilesSkipped,
			"took", time.Since(started))
	}

	writeJSON(w, http.StatusOK, document)
}

/*
Load is the whole pipeline behind the features endpoint, with no HTTP in it.

Extracted so the cache warm below can be the same code rather than a second copy of it. A
warm that resolved or keyed differently from a request would fill the cache with entries no
request ever looks up — and it would look like it was working, because the log line it writes
is about the warm and not about the hit that never happens.

The bool is whether the answer came from the cache.
*/
func (deps Deps) Load(
	ctx context.Context,
	owner, name, ref string,
) (schema.RepoFeatures, bool, error) {
	// The ref is resolved before anything else because the SHA is the cache key and the
	// seed. Branches move; the music must not.
	repo, err := deps.GitHub.Resolve(ctx, owner, name, ref)
	if err != nil {
		return schema.RepoFeatures{}, false, stepError{"resolving", err}
	}

	if document, found := deps.Cache.Get(ctx, repo.CommitSHA); found {
		return document, true, nil
	}

	tarball, err := deps.GitHub.Tarball(ctx, repo.Owner, repo.Name, repo.CommitSHA)
	if err != nil {
		return schema.RepoFeatures{}, false, stepError{"fetching the archive", err}
	}
	defer tarball.Close()

	document, err := features.FromTarball(ctx, repo, tarball, time.Now())
	if err != nil {
		return schema.RepoFeatures{}, false, stepError{"parsing", err}
	}

	deps.Cache.Put(ctx, repo.CommitSHA, document)
	return document, false, nil
}

/*
stepError says where in the pipeline something went wrong.

Carried rather than logged at the point of failure, because the sentence a person reads and
the line an operator reads are decided in one place — fail — and it needs to be able to say
whether GitHub was slow or the repository was simply enormous. Those look identical as a
deadline and are different problems.
*/
type stepError struct {
	step string
	err  error
}

func (e stepError) Error() string { return e.step + ": " + e.err.Error() }
func (e stepError) Unwrap() error { return e.err }

func stepOf(err error) string {
	var step stepError
	if errors.As(err, &step) {
		return step.step
	}
	return "reading"
}

/*
fail turns an error from anywhere in the repository pipeline into a status and a sentence.

The sentences are for a person looking at a repository that did not play, so they say what
happened and, where there is one, what would have worked. The distinction that matters is
whose problem it is: a repository we cannot read is the visitor's to fix by picking another,
a spent rate limit or a rejected token is ours and must not be dressed up as theirs.

Only the first two cases are about a repository. Everything below them is about the exchange
with GitHub and reads the same whatever was being asked for, which is why it lives in
failUpstream and is shared with the username lookup.
*/
func (deps Deps) fail(w http.ResponseWriter, owner, name string, err error) {
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

	default:
		deps.failUpstream(w, stepOf(err), repo, err)
	}
}

// failUpstream covers everything that is about GitHub rather than about what was asked for.
func (deps Deps) failUpstream(w http.ResponseWriter, stage, subject string, err error) {
	switch {
	case errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled):
		// The client going away lands here too. Nobody reads that response, and writing it
		// costs nothing, so it is not worth a branch of its own.
		deps.Logger.Warn("gave up", "subject", subject, "stage", stage, "error", err)
		writeError(w, http.StatusGatewayTimeout,
			subject+" took longer than Codetta waits. Very large repositories can do this — "+
				"try again, or try a smaller one.")

	case errors.Is(err, github.ErrRateLimited):
		// Ours, not theirs. GitHub's hourly budget is spent for everyone until it resets.
		deps.Logger.Error("github rate limit exhausted", "subject", subject, "error", err)
		w.Header().Set("Retry-After", "300")
		writeError(w, http.StatusServiceUnavailable,
			"Codetta has run out of GitHub requests for the moment. Try again shortly.")

	case errors.Is(err, github.ErrUnauthorized):
		// A misconfigured or expired token. Never described to the caller as their mistake,
		// and never with any detail that hints at the credential.
		deps.Logger.Error("github rejected the token", "subject", subject, "stage", stage)
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
			deps.Logger.Warn("could not reach github", "subject", subject, "stage", stage, "error", err)
			writeError(w, http.StatusBadGateway,
				"Codetta could not reach GitHub just then. Try again.")
			return
		}

		deps.Logger.Error("request failed", "subject", subject, "stage", stage, "error", err)
		writeError(w, http.StatusInternalServerError, "something went wrong "+stage+" "+subject+".")
	}
}

/*
DefaultLimits are the allowances a deployment gets unless it says otherwise.

The numbers come from GitHub's budget rather than from taste. A token allows 5,000 requests
an hour; a repository costs three of them (metadata, commit, tarball) and a username costs
two plus a thumbnail. Twenty a minute across everybody is 1,200 an hour at three requests
each — comfortably inside the budget with room for the retries a spike produces, and inside
the search endpoint's much tighter separate limit as well, which the username path needs.

The caller's own allowance is set by what a person does rather than by arithmetic: ten a
minute is faster than anyone can listen, and a burst of five covers arriving on a link,
mistyping, and trying again without ever being told to wait.
*/
func DefaultLimits() (caller, global *ratelimit.Limiter) {
	return ratelimit.New(10, 5), ratelimit.New(20, 40)
}

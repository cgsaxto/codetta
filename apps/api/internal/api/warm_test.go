package api

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"codetta.dev/api/internal/cache"
	"codetta.dev/api/internal/github"
	"codetta.dev/api/internal/ratelimit"
	"codetta.dev/schema"
)

// counting stands in for Redis. miniredis has its own tests in internal/cache; what matters
// here is which keys the warm writes and whether a second run writes them again.
type counting struct {
	held  map[string]schema.RepoFeatures
	reads atomic.Int64
	puts  atomic.Int64
}

func newCounting() *counting {
	return &counting{held: map[string]schema.RepoFeatures{}}
}

func (c *counting) Get(_ context.Context, sha string) (schema.RepoFeatures, bool) {
	c.reads.Add(1)
	document, found := c.held[sha]
	return document, found
}

func (c *counting) Put(_ context.Context, sha string, document schema.RepoFeatures) {
	c.puts.Add(1)
	c.held[sha] = document
}

func warmDeps(t *testing.T, routes map[string]route, store cache.Cache) (Deps, *atomic.Int64) {
	t.Helper()

	gh, calls := upstream(t, routes)
	return Deps{
		GitHub: github.New("test-token", github.WithBaseURL(gh.URL)),
		Cache:  store,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Budget: 5 * time.Second,
	}, calls
}

func TestWarmParsesEachRepositoryOnce(t *testing.T) {
	store := newCounting()
	deps, calls := warmDeps(t, happyRoutes(t), store)

	deps.WarmGallery(context.Background(), []RepoRef{{Owner: "o", Name: "r"}})
	if store.puts.Load() != 1 {
		t.Fatalf("wrote %d entries, want the repository cached", store.puts.Load())
	}
	first := calls.Load()

	// The second run is the one that matters: a warm that re-parses on every boot spends the
	// GitHub budget for nothing, and with a persistent Redis that is every deploy.
	deps.WarmGallery(context.Background(), []RepoRef{{Owner: "o", Name: "r"}})
	if store.puts.Load() != 1 {
		t.Errorf("wrote %d entries, want the cached one left alone", store.puts.Load())
	}
	// Two calls to resolve the ref, and no tarball. The SHA is the key, so the ref has to be
	// resolved before the cache can be asked anything at all.
	if spent := calls.Load() - first; spent != 2 {
		t.Errorf("second warm made %d GitHub calls, want 2 and no download", spent)
	}
}

func TestWarmKeysTheSameEntryARequestReads(t *testing.T) {
	// The bug this rules out is a warm that fills the cache with entries nothing looks up.
	// It would log success on every boot and never produce a single hit.
	store := newCounting()
	deps, _ := warmDeps(t, happyRoutes(t), store)
	deps.WarmGallery(context.Background(), []RepoRef{{Owner: "o", Name: "r"}})

	server := httptest.NewServer(Handler(deps))
	t.Cleanup(server.Close)

	before := store.puts.Load()
	response, body := get(t, server, "/v1/features/o/r")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.StatusCode, body)
	}
	if store.puts.Load() != before {
		t.Error("the request wrote its own entry, so the warm had cached something else")
	}
}

func TestWarmSurvivesARepositoryItCannotRead(t *testing.T) {
	store := newCounting()
	routes := happyRoutes(t)
	deps, _ := warmDeps(t, routes, store)

	// The first is missing entirely; the second is fine. A gone repository must not stop the
	// rest of the list — a slower first visitor is the whole cost of a failed warm.
	deps.WarmGallery(context.Background(), []RepoRef{
		{Owner: "gone", Name: "away"},
		{Owner: "o", Name: "r"},
	})

	if store.puts.Load() != 1 {
		t.Errorf("cached %d, want the reachable one warmed anyway", store.puts.Load())
	}
}

func TestWarmSkipsItselfWithoutACache(t *testing.T) {
	// Eight parses and twenty-four GitHub requests spent on entries nothing can read back.
	deps, calls := warmDeps(t, happyRoutes(t), cache.Nop{})

	deps.WarmGallery(context.Background(), []RepoRef{{Owner: "o", Name: "r"}})
	if calls.Load() != 0 {
		t.Errorf("made %d GitHub calls with no cache, want none", calls.Load())
	}
}

func TestWarmStopsWhenTheProcessIsShuttingDown(t *testing.T) {
	deps, calls := warmDeps(t, happyRoutes(t), newCounting())

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	deps.WarmGallery(ctx, []RepoRef{{Owner: "o", Name: "r"}})
	if calls.Load() != 0 {
		t.Errorf("kept working after cancellation, %d calls", calls.Load())
	}
}

func TestCallerLimitRefusesBeforeGitHubIsTouched(t *testing.T) {
	deps, calls := warmDeps(t, happyRoutes(t), cache.Nop{})
	deps.Caller = ratelimit.New(60, 1)

	server := httptest.NewServer(Handler(deps))
	t.Cleanup(server.Close)

	if response, body := get(t, server, "/v1/features/o/r"); response.StatusCode != http.StatusOK {
		t.Fatalf("first request: %d %s", response.StatusCode, body)
	}
	spent := calls.Load()

	response, body := get(t, server, "/v1/features/o/r")
	if response.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", response.StatusCode)
	}
	// The point of a limiter is the work it prevents, not the status it returns.
	if calls.Load() != spent {
		t.Error("a refused request still reached GitHub")
	}
	if response.Header.Get("Retry-After") == "" {
		t.Error("no Retry-After, so the caller has nothing to wait out")
	}
	if !strings.Contains(body, "Codetta reads") {
		t.Errorf("body = %s, want it to say why", body)
	}
}

func TestGlobalLimitIsOursNotTheirs(t *testing.T) {
	deps, _ := warmDeps(t, happyRoutes(t), cache.Nop{})
	// Nothing left for anybody, and a caller allowance nobody will hit.
	deps.Caller = ratelimit.New(600, 100)
	deps.Global = ratelimit.New(600, 0)

	server := httptest.NewServer(Handler(deps))
	t.Cleanup(server.Close)

	response, body := get(t, server, "/v1/features/o/r")
	// 503 rather than 429: the caller did nothing wrong, and dressing our own capacity up as
	// their mistake is the distinction fail() already makes everywhere else.
	if response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", response.StatusCode)
	}
	if !strings.Contains(body, "front page") {
		t.Errorf("body = %s, want it to point at the thing that still works", body)
	}
}

func TestHealthIsNeverRateLimited(t *testing.T) {
	deps, _ := warmDeps(t, happyRoutes(t), cache.Nop{})
	deps.Caller = ratelimit.New(60, 0)
	deps.Global = ratelimit.New(60, 0)

	server := httptest.NewServer(Handler(deps))
	t.Cleanup(server.Close)

	// A platform asking whether this process is alive must never be told to come back later.
	for attempt := 0; attempt < 3; attempt++ {
		if response, _ := get(t, server, "/healthz"); response.StatusCode != http.StatusOK {
			t.Fatalf("healthz = %d on attempt %d", response.StatusCode, attempt)
		}
	}
}

package cache

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"codetta.dev/schema"
	"github.com/alicebob/miniredis/v2"
)

// miniredis is a real Redis implementation in-process, so these exercise the actual client
// and the actual protocol without `make api-test` needing a server or a network.

const sha = "7c8e5e7ab2f0d5a1c4b93f6e2d8a105f3bc47e9d"

func quietLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func document() schema.RepoFeatures {
	return schema.RepoFeatures{
		SchemaVersion: schema.SchemaVersion,
		Repo: schema.RepoIdentity{
			Owner: "facebook", Name: "react", Ref: "main",
			CommitSha: sha, PrimaryLanguage: "JavaScript", Stars: 232400,
			FetchedAt: "2026-08-08T12:00:00Z",
		},
		Seed:      sha[:8],
		Totals:    schema.Totals{FilesScanned: 4, LinesOfCode: 34},
		Languages: []schema.LanguageShare{{Name: "JavaScript", Share: 1, Files: 4}},
		Modules:   []schema.RepoModule{{Path: "packages/react", Share: 1, Files: 4}},
		Timeline:  []schema.TimelineEntry{{Index: 0, ModulePath: "packages/react", Path: "packages/react/a.js"}},
	}
}

func newRedis(t *testing.T) (*Redis, *miniredis.Miniredis) {
	t.Helper()

	server := miniredis.RunT(t)
	cache, err := New("redis://"+server.Addr(), quietLogger())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	redisCache, ok := cache.(*Redis)
	if !ok {
		t.Fatalf("New returned %T, want *Redis", cache)
	}
	t.Cleanup(func() { _ = redisCache.Close() })
	return redisCache, server
}

func TestRoundTrip(t *testing.T) {
	cache, _ := newRedis(t)
	ctx := context.Background()

	if _, found := cache.Get(ctx, sha); found {
		t.Fatal("found something in an empty cache")
	}

	want := document()
	cache.Put(ctx, sha, want)

	got, found := cache.Get(ctx, sha)
	if !found {
		t.Fatal("stored a document and could not read it back")
	}
	if got.Repo.CommitSha != want.Repo.CommitSha || got.Totals.LinesOfCode != want.Totals.LinesOfCode {
		t.Errorf("document changed in transit: %+v", got)
	}
	if len(got.Modules) != 1 || got.Modules[0].Path != "packages/react" {
		t.Errorf("modules changed in transit: %+v", got.Modules)
	}
}

func TestKeyIsTheCommitSHAAndCarriesTheSchemaVersion(t *testing.T) {
	// Never the repo URL: branches move, and a cached document must not follow one.
	// The version prefix stops a schemaVersion bump from serving the old shape.
	cache, server := newRedis(t)
	cache.Put(context.Background(), sha, document())

	if !server.Exists(KeyPrefix + sha) {
		t.Fatalf("expected key %q, found %v", KeyPrefix+sha, server.Keys())
	}
}

func TestEntriesExpire(t *testing.T) {
	cache, server := newRedis(t)
	cache.Put(context.Background(), sha, document())

	ttl := server.TTL(KeyPrefix + sha)
	if ttl != TTL {
		t.Errorf("TTL = %v, want %v", ttl, TTL)
	}

	server.FastForward(TTL + time.Second)
	if _, found := cache.Get(context.Background(), sha); found {
		t.Error("an expired document came back")
	}
}

func TestAnOutageIsJustAMiss(t *testing.T) {
	// The sentence this package exists for: cache miss and cache unavailable take the same
	// path. Neither Get nor Put can report a failure, so no caller can turn one into a 500.
	cache, server := newRedis(t)
	ctx := context.Background()

	cache.Put(ctx, sha, document())
	server.Close()

	if _, found := cache.Get(ctx, sha); found {
		t.Error("Get claimed a hit against a dead server")
	}
	// Must not panic, and must not block for anything like the request budget.
	cache.Put(ctx, sha, document())
}

func TestRedisComingBackHealsWithoutARestart(t *testing.T) {
	// New deliberately does not ping. A Redis that is down at boot and up later should just
	// start working, because requiring it at startup would make the cache a dependency.
	server := miniredis.RunT(t)
	address := server.Addr()
	server.Close()

	cache, err := New("redis://"+address, quietLogger())
	if err != nil {
		t.Fatalf("New refused to build a cache against a dead server: %v", err)
	}
	ctx := context.Background()

	if _, found := cache.Get(ctx, sha); found {
		t.Fatal("hit against a server that is not running")
	}

	revived, err := miniredis.Run()
	if err != nil {
		t.Fatalf("restarting: %v", err)
	}
	defer revived.Close()
	if err := revived.StartAddr(address); err != nil {
		// Ports are not always reclaimable; the design point is covered by the outage test.
		t.Skipf("could not rebind %s: %v", address, err)
	}

	cache.Put(ctx, sha, document())
	if _, found := cache.Get(ctx, sha); !found {
		t.Error("cache did not recover once Redis returned")
	}
}

func TestUnreadableValuesAreMisses(t *testing.T) {
	// Recomputing is always correct, so a corrupted entry needs no repair path.
	cache, server := newRedis(t)
	if err := server.Set(KeyPrefix+sha, "{not json"); err != nil {
		t.Fatalf("seeding: %v", err)
	}

	if _, found := cache.Get(context.Background(), sha); found {
		t.Error("returned a document parsed from nonsense")
	}
}

func TestDocumentsFromAnotherSchemaVersionAreMisses(t *testing.T) {
	cache, server := newRedis(t)
	if err := server.Set(KeyPrefix+sha, `{"schemaVersion":99,"seed":"deadbeef"}`); err != nil {
		t.Fatalf("seeding: %v", err)
	}

	if _, found := cache.Get(context.Background(), sha); found {
		t.Error("served a document from a schema version this build does not speak")
	}
}

func TestNoRedisConfiguredStillWorks(t *testing.T) {
	// CLAUDE.md: the app must work correctly with a cold or absent Redis.
	cache, err := New("", quietLogger())
	if err != nil {
		t.Fatalf("New(\"\"): %v", err)
	}
	if _, ok := cache.(Nop); !ok {
		t.Fatalf("New(\"\") returned %T, want Nop", cache)
	}

	ctx := context.Background()
	cache.Put(ctx, sha, document())
	if _, found := cache.Get(ctx, sha); found {
		t.Error("Nop reported a hit")
	}
}

func TestAMalformedURLIsAConfigurationError(t *testing.T) {
	// The one failure that is worth refusing at startup: a typo in the address is a setup
	// mistake, and silently running without a cache would hide it.
	if _, err := New("not-a-url", quietLogger()); err == nil {
		t.Error("accepted a malformed redis url")
	}
}

func TestOperationsGiveUpQuicklyEnoughToBeWorthHaving(t *testing.T) {
	// A wedged Redis must not eat the request budget. A cache exists to make things faster,
	// so it does not get to make anything slower.
	if Timeout > time.Second {
		t.Errorf("Timeout = %v, too long to sit inside a 25s budget", Timeout)
	}

	server := miniredis.RunT(t)
	cache, err := New("redis://"+server.Addr(), quietLogger())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	server.Close()

	start := time.Now()
	cache.Get(context.Background(), sha)
	cache.Put(context.Background(), sha, document())
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Errorf("a dead Redis cost %v", elapsed)
	}
}

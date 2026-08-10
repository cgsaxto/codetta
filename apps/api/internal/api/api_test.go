package api

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
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
	"codetta.dev/schema"
)

// Offline, like the rest of make api-test. GitHub is an httptest server, so this never spends
// a rate limit and never depends on a network — which matters most for the service whose
// entire job is calling a rate-limited API.

const sha = "7c8e5e7ab2f0d5a1c4b93f6e2d8a105f3bc47e9d"

var repoFiles = map[string]string{
	"packages/core/index.ts": "export class Engine {\n  async run() {\n    if (true) { return 1 }\n  }\n}",
	"packages/core/util.ts":  "// helper\nexport function helper(n: number) { return n }",
	"packages/cli/main.go":   "package main\n\nfunc Run() error {\n\treturn nil\n}",
}

func tarball(t *testing.T, files map[string]string) []byte {
	t.Helper()

	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for name, body := range files {
		header := &tar.Header{
			Name: "o-r-" + sha[:7] + "/" + name, Mode: 0o644,
			Size: int64(len(body)), Typeflag: tar.TypeReg,
		}
		if err := tw.WriteHeader(header); err != nil {
			t.Fatalf("header: %v", err)
		}
		if _, err := tw.Write([]byte(body)); err != nil {
			t.Fatalf("body: %v", err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatalf("tar: %v", err)
	}
	if err := gz.Close(); err != nil {
		t.Fatalf("gzip: %v", err)
	}
	return buf.Bytes()
}

type route struct {
	status int
	body   string
	raw    []byte
	header map[string]string
	delay  time.Duration
}

// upstream stands in for GitHub. Unrouted paths 404, which is what an unknown repository
// looks like anyway.
func upstream(t *testing.T, routes map[string]route) (*httptest.Server, *atomic.Int64) {
	t.Helper()

	var calls atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		found, ok := routes[r.URL.Path]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if found.delay > 0 {
			select {
			case <-time.After(found.delay):
			case <-r.Context().Done():
				return
			}
		}
		for key, value := range found.header {
			w.Header().Set(key, value)
		}
		w.WriteHeader(found.status)
		if found.raw != nil {
			_, _ = w.Write(found.raw)
			return
		}
		_, _ = io.WriteString(w, found.body)
	}))
	t.Cleanup(server.Close)
	return server, &calls
}

func happyRoutes(t *testing.T) map[string]route {
	return map[string]route{
		"/repos/o/r":                {status: 200, body: `{"language":"TypeScript","stargazers_count":9,"default_branch":"main"}`},
		"/repos/o/r/commits/main":   {status: 200, body: `{"sha":"` + sha + `"}`},
		"/repos/o/r/tarball/" + sha: {status: 200, raw: tarball(t, repoFiles)},
	}
}

func serve(t *testing.T, routes map[string]route, store cache.Cache) (*httptest.Server, *atomic.Int64) {
	t.Helper()

	gh, calls := upstream(t, routes)
	handler := Handler(Deps{
		GitHub: github.New("test-token", github.WithBaseURL(gh.URL)),
		Cache:  store,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Budget: 5 * time.Second,
	})
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return server, calls
}

func get(t *testing.T, server *httptest.Server, path string) (*http.Response, string) {
	t.Helper()

	response, err := server.Client().Get(server.URL + path)
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	t.Cleanup(func() { _ = response.Body.Close() })

	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("reading body: %v", err)
	}
	return response, string(body)
}

func TestServesADocumentForARepository(t *testing.T) {
	server, _ := serve(t, happyRoutes(t), nil)
	response, body := get(t, server, "/v1/features/o/r")

	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.StatusCode, body)
	}

	var document schema.RepoFeatures
	decoder := json.NewDecoder(strings.NewReader(body))
	// The contract, enforced: apps/web is typed against exactly these fields, so an extra one
	// here is a schema drift that would reach the browser as a silent surprise.
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&document); err != nil {
		t.Fatalf("decoding: %v\n%s", err, body)
	}

	if document.SchemaVersion != schema.SchemaVersion {
		t.Errorf("schemaVersion = %d", document.SchemaVersion)
	}
	if document.Repo.CommitSha != sha || document.Seed != sha[:8] {
		t.Errorf("sha = %q, seed = %q", document.Repo.CommitSha, document.Seed)
	}
	if document.Totals.FilesScanned != 3 {
		t.Errorf("filesScanned = %d, want 3", document.Totals.FilesScanned)
	}
	if len(document.Modules) == 0 {
		t.Error("no modules, so apps/web would have nothing above pad and bass")
	}
}

func TestResolvesTheRefBeforeAnythingElse(t *testing.T) {
	// The SHA is the cache key and the seed, so a branch name has to become one before any
	// work happens. Branches move; the music must not.
	routes := happyRoutes(t)
	routes["/repos/o/r/commits/v2.0"] = route{status: 200, body: `{"sha":"` + sha + `"}`}

	server, _ := serve(t, routes, nil)
	response, body := get(t, server, "/v1/features/o/r?ref=v2.0")

	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.StatusCode, body)
	}
	if !strings.Contains(body, `"ref":"v2.0"`) {
		t.Errorf("document does not record the ref it was asked for:\n%s", body)
	}
}

func TestASecondRequestIsServedFromTheCache(t *testing.T) {
	memory := &countingCache{inner: map[string]schema.RepoFeatures{}}
	server, calls := serve(t, happyRoutes(t), memory)

	first, body := get(t, server, "/v1/features/o/r")
	if first.StatusCode != http.StatusOK {
		t.Fatalf("first request: %d %s", first.StatusCode, body)
	}
	afterFirst := calls.Load()

	second, again := get(t, server, "/v1/features/o/r")
	if second.StatusCode != http.StatusOK {
		t.Fatalf("second request: %d %s", second.StatusCode, again)
	}
	if again != body {
		t.Error("the cached document differs from the one that was stored")
	}

	// Two calls to resolve the ref, and no third for the tarball: the archive is the
	// expensive part and the whole reason the cache exists.
	if spent := calls.Load() - afterFirst; spent != 2 {
		t.Errorf("second request made %d upstream calls, want 2 (resolve only)", spent)
	}
	if memory.puts != 1 {
		t.Errorf("stored %d documents, want 1", memory.puts)
	}
}

func TestAMissingRepositoryIsA404(t *testing.T) {
	server, _ := serve(t, map[string]route{}, nil)
	response, body := get(t, server, "/v1/features/nobody/nothing")

	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want 404. body = %s", response.StatusCode, body)
	}
	// A private repository 404s from here too, and a reader deserves to know that rather
	// than concluding their repository does not exist.
	if !strings.Contains(body, "Private") {
		t.Errorf("message does not explain the private case: %s", body)
	}
}

func TestARepositoryInNoSupportedLanguageIsA422(t *testing.T) {
	// docs/features-schema.md: a repository with zero supported files returns a 422 with a
	// message naming the languages we do support. It is a normal outcome, not a failure.
	routes := happyRoutes(t)
	routes["/repos/o/r/tarball/"+sha] = route{status: 200, raw: tarball(t, map[string]string{
		"src/main.c":  "int main(){return 0;}",
		"lib/thing.h": "#pragma once",
		"README.md":   "# docs",
	})}

	server, _ := serve(t, routes, nil)
	response, body := get(t, server, "/v1/features/o/r")

	if response.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422. body = %s", response.StatusCode, body)
	}
	for _, language := range []string{"Go", "JavaScript", "Python", "TypeScript"} {
		if !strings.Contains(body, language) {
			t.Errorf("422 does not name %s: %s", language, body)
		}
	}
}

func TestARepositoryOverTheBudgetIsA504(t *testing.T) {
	routes := happyRoutes(t)
	routes["/repos/o/r"] = route{
		status: 200,
		body:   `{"language":"Go","stargazers_count":1,"default_branch":"main"}`,
		delay:  300 * time.Millisecond,
	}

	gh, _ := upstream(t, routes)
	handler := Handler(Deps{
		GitHub: github.New("test-token", github.WithBaseURL(gh.URL)),
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Budget: 50 * time.Millisecond,
	})
	server := httptest.NewServer(handler)
	defer server.Close()

	response, body := get(t, server, "/v1/features/o/r")
	if response.StatusCode != http.StatusGatewayTimeout {
		t.Fatalf("status = %d, want 504. body = %s", response.StatusCode, body)
	}
	if !strings.Contains(body, "try") && !strings.Contains(body, "Try") {
		t.Errorf("504 does not suggest what to do next: %s", body)
	}
}

func TestASpentRateLimitIsOursNotTheirs(t *testing.T) {
	server, _ := serve(t, map[string]route{
		"/repos/o/r": {
			status: 403,
			header: map[string]string{"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1"},
		},
	}, nil)

	response, body := get(t, server, "/v1/features/o/r")
	if response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503. body = %s", response.StatusCode, body)
	}
	if response.Header.Get("Retry-After") == "" {
		t.Error("no Retry-After on a 503 that will resolve itself")
	}
	// Nothing about the visitor's repository being at fault, and nothing about the token.
	if strings.Contains(strings.ToLower(body), "token") {
		t.Errorf("the message mentions the credential: %s", body)
	}
}

func TestAnUnreachableGitHubIsRetryableRatherThanAMystery(t *testing.T) {
	// The failure a real network actually produces. GitHub dropped a connection mid-request
	// during manual testing and it came back as "something went wrong resolving django/django"
	// with a 500 — no advice, when pressing the button again was all it needed.
	dead := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	address := dead.URL
	dead.Close()

	handler := Handler(Deps{
		GitHub: github.New("test-token", github.WithBaseURL(address)),
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Budget: 2 * time.Second,
	})
	server := httptest.NewServer(handler)
	defer server.Close()

	response, body := get(t, server, "/v1/features/o/r")
	if response.StatusCode != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502. body = %s", response.StatusCode, body)
	}
	if !strings.Contains(body, "Try again") {
		t.Errorf("502 does not say to retry: %s", body)
	}
}

func TestARejectedTokenNeverLooksLikeTheCallersFault(t *testing.T) {
	server, _ := serve(t, map[string]route{
		"/repos/o/r": {status: 401},
	}, nil)

	response, body := get(t, server, "/v1/features/o/r")
	if response.StatusCode != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500. body = %s", response.StatusCode, body)
	}
	if strings.Contains(strings.ToLower(body), "token") {
		t.Errorf("the message hints at the credential: %s", body)
	}
}

func TestEveryErrorIsJSONWithAMessage(t *testing.T) {
	// apps/web renders whatever comes back. An HTML error page or a bare status would reach
	// a visitor as "undefined".
	for _, path := range []string{"/v1/features/nobody/nothing", "/v1/features/o/r"} {
		_, body := get(t, serveEmpty(t), path)

		var parsed errorBody
		if err := json.Unmarshal([]byte(body), &parsed); err != nil {
			t.Errorf("%s: body is not JSON: %s", path, body)
			continue
		}
		if parsed.Error == "" {
			t.Errorf("%s: JSON carries no message: %s", path, body)
		}
	}
}

func serveEmpty(t *testing.T) *httptest.Server {
	t.Helper()
	server, _ := serve(t, map[string]route{}, nil)
	return server
}

func TestTheBrowserIsAllowedToCallThis(t *testing.T) {
	// apps/web runs on another origin in development and may in production. The API takes no
	// credentials and sets no cookies, so opening it costs nothing.
	server, _ := serve(t, happyRoutes(t), nil)
	response, _ := get(t, server, "/healthz")

	if got := response.Header.Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("Access-Control-Allow-Origin = %q", got)
	}
}

func TestHealthzNeedsNothingWorking(t *testing.T) {
	// A liveness probe that calls GitHub would report the service down whenever GitHub is.
	server, calls := serve(t, map[string]route{}, nil)
	response, body := get(t, server, "/healthz")

	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.StatusCode, body)
	}
	if calls.Load() != 0 {
		t.Errorf("healthz made %d upstream calls, want 0", calls.Load())
	}
}

// countingCache is an in-memory Cache that records how often it was written to.
type countingCache struct {
	inner map[string]schema.RepoFeatures
	puts  int
}

func (c *countingCache) Get(_ context.Context, key string) (schema.RepoFeatures, bool) {
	document, found := c.inner[key]
	return document, found
}

func (c *countingCache) Put(_ context.Context, key string, document schema.RepoFeatures) {
	c.inner[key] = document
	c.puts++
}

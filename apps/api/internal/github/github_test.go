package github

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Everything here runs against an httptest server. Nothing reaches api.github.com, so
// `make api-test` works offline and never spends a rate limit — which matters more than
// usual for a service whose entire job is talking to a rate-limited API.

const fakeSHA = "7c8e5e7ab2f0d5a1c4b93f6e2d8a105f3bc47e9d"

type route struct {
	status  int
	body    string
	headers map[string]string
}

func newServer(t *testing.T, routes map[string]route) (*Client, *[]string) {
	t.Helper()

	var seen []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.URL.Path)

		if got := r.Header.Get("Authorization"); got != "Bearer test-token" {
			t.Errorf("Authorization = %q, want a bearer token", got)
		}
		if got := r.Header.Get("X-GitHub-Api-Version"); got != apiVersion {
			t.Errorf("X-GitHub-Api-Version = %q, want %q", got, apiVersion)
		}

		res, ok := routes[r.URL.Path]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		for k, v := range res.headers {
			w.Header().Set(k, v)
		}
		w.WriteHeader(res.status)
		_, _ = io.WriteString(w, res.body)
	}))
	t.Cleanup(server.Close)

	return New("test-token", WithBaseURL(server.URL), WithHTTPClient(server.Client())), &seen
}

func TestResolveReturnsTheCommitAndMetadata(t *testing.T) {
	client, _ := newServer(t, map[string]route{
		"/repos/facebook/react": {
			status: 200,
			body:   `{"language":"JavaScript","stargazers_count":232400,"default_branch":"main"}`,
		},
		"/repos/facebook/react/commits/main": {
			status: 200,
			body:   `{"sha":"` + fakeSHA + `"}`,
		},
	})

	repo, err := client.Resolve(context.Background(), "facebook", "react", "main")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	if repo.CommitSHA != fakeSHA {
		t.Errorf("CommitSHA = %q, want %q", repo.CommitSHA, fakeSHA)
	}
	if repo.PrimaryLanguage != "JavaScript" {
		t.Errorf("PrimaryLanguage = %q", repo.PrimaryLanguage)
	}
	if repo.Stars != 232400 {
		t.Errorf("Stars = %d", repo.Stars)
	}
}

func TestResolveFallsBackToTheDefaultBranch(t *testing.T) {
	client, seen := newServer(t, map[string]route{
		"/repos/o/r":                {status: 200, body: `{"default_branch":"trunk"}`},
		"/repos/o/r/commits/trunk":  {status: 200, body: `{"sha":"` + fakeSHA + `"}`},
		"/repos/o/r/commits/master": {status: 500, body: `wrong branch`},
	})

	repo, err := client.Resolve(context.Background(), "o", "r", "")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if repo.Ref != "trunk" {
		t.Errorf("Ref = %q, want trunk", repo.Ref)
	}
	if !strings.Contains(strings.Join(*seen, " "), "/commits/trunk") {
		t.Errorf("did not ask for the default branch, saw %v", *seen)
	}
}

func TestResolveRejectsSomethingThatIsNotASHA(t *testing.T) {
	// The SHA is the cache key and the seed. A truncated or malformed one would silently
	// produce a different piece of music for the same commit.
	client, _ := newServer(t, map[string]route{
		"/repos/o/r":              {status: 200, body: `{"default_branch":"main"}`},
		"/repos/o/r/commits/main": {status: 200, body: `{"sha":"abc123"}`},
	})

	_, err := client.Resolve(context.Background(), "o", "r", "main")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

func TestResolveMapsGitHubFailures(t *testing.T) {
	cases := []struct {
		name    string
		route   route
		wantErr error
	}{
		{"missing repo", route{status: 404}, ErrNotFound},
		{"bad token", route{status: 401}, ErrUnauthorized},
		{
			"rate limited",
			route{status: 403, headers: map[string]string{"X-RateLimit-Remaining": "0"}},
			ErrRateLimited,
		},
		{
			// 403 without a spent budget is a permissions problem, not a rate limit. Telling
			// a user to wait an hour for a token that will never work is the worst outcome.
			"forbidden but not rate limited",
			route{status: 403, headers: map[string]string{"X-RateLimit-Remaining": "4999"}},
			ErrUnauthorized,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			client, _ := newServer(t, map[string]route{"/repos/o/r": tc.route})
			_, err := client.Resolve(context.Background(), "o", "r", "main")
			if !errors.Is(err, tc.wantErr) {
				t.Fatalf("err = %v, want %v", err, tc.wantErr)
			}
		})
	}
}

func TestResolveRequiresOwnerAndName(t *testing.T) {
	client, _ := newServer(t, map[string]route{})
	if _, err := client.Resolve(context.Background(), "", "r", "main"); !errors.Is(err, ErrNotFound) {
		t.Errorf("empty owner: err = %v, want ErrNotFound", err)
	}
	if _, err := client.Resolve(context.Background(), "o", "", "main"); !errors.Is(err, ErrNotFound) {
		t.Errorf("empty name: err = %v, want ErrNotFound", err)
	}
}

func TestTarballStreamsTheBody(t *testing.T) {
	client, seen := newServer(t, map[string]route{
		"/repos/o/r/tarball/" + fakeSHA: {status: 200, body: "gzip-bytes-would-go-here"},
	})

	body, err := client.Tarball(context.Background(), "o", "r", fakeSHA)
	if err != nil {
		t.Fatalf("Tarball: %v", err)
	}
	defer body.Close()

	data, err := io.ReadAll(body)
	if err != nil {
		t.Fatalf("reading: %v", err)
	}
	if string(data) != "gzip-bytes-would-go-here" {
		t.Errorf("body = %q", data)
	}

	// The tarball endpoint, addressed by SHA. docs/features-schema.md allows no other way
	// of getting source out of GitHub, and never a clone.
	if got := (*seen)[0]; got != "/repos/o/r/tarball/"+fakeSHA {
		t.Errorf("requested %q", got)
	}
}

func TestTarballReportsAMissingCommit(t *testing.T) {
	client, _ := newServer(t, map[string]route{})
	if _, err := client.Tarball(context.Background(), "o", "r", fakeSHA); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

func TestTheClientImposesNoTimeoutOfItsOwn(t *testing.T) {
	// http.Client.Timeout covers reading the body, so any value here would cut off a tarball
	// that is merely large or on a slow link. facebook/react is 9.7 MB and took 11 s to
	// download on the connection this was written on; a 25-second client timeout killed it
	// mid-body while the caller still had budget left. The context owns the deadline.
	client := New("test-token")
	if client.http.Timeout != 0 {
		t.Errorf("http client Timeout = %v, want 0 so the context decides", client.http.Timeout)
	}
}

func TestRequestsCarryTheContext(t *testing.T) {
	client, _ := newServer(t, map[string]route{
		"/repos/o/r": {status: 200, body: `{"default_branch":"main"}`},
	})

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if _, err := client.Resolve(ctx, "o", "r", "main"); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
}

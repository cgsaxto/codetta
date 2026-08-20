package api

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"codetta.dev/api/internal/github"
)

// serveUser is the repository helper's twin, with the query string kept. The search endpoint
// puts everything that matters into one, so a test that only sees the path sees nothing.
func serveUser(t *testing.T, routes map[string]route) (*httptest.Server, *[]string) {
	t.Helper()

	var seen []string
	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.URL.RequestURI())
		found, ok := routes[r.URL.Path]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		for key, value := range found.header {
			w.Header().Set(key, value)
		}
		w.WriteHeader(found.status)
		_, _ = io.WriteString(w, found.body)
	}))
	t.Cleanup(gh.Close)

	server := httptest.NewServer(Handler(Deps{
		GitHub: github.New("test-token", github.WithBaseURL(gh.URL)),
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Budget: 5 * time.Second,
	}))
	t.Cleanup(server.Close)
	return server, &seen
}

func searchResults(items ...string) route {
	return route{status: 200, body: `{"total_count":` + strconv.Itoa(len(items)) + `,"items":[` +
		strings.Join(items, ",") + `]}`}
}

func item(owner, name, language string, stars int) string {
	return `{"name":"` + name + `","owner":{"login":"` + owner + `"},"language":"` + language +
		`","stargazers_count":` + strconv.Itoa(stars) + `,"default_branch":"main"}`
}

func decodeUser(t *testing.T, body string) userBody {
	t.Helper()

	var decoded userBody
	if err := json.Unmarshal([]byte(body), &decoded); err != nil {
		t.Fatalf("decoding %q: %v", body, err)
	}
	return decoded
}

func TestUserPicksTheMostStarredReadableRepository(t *testing.T) {
	server, _ := serveUser(t, map[string]route{
		"/users/torvalds": {status: 200,
			body: `{"login":"torvalds","name":"Linus Torvalds","type":"User"}`},
		"/search/repositories": searchResults(
			item("torvalds", "linux", "C", 190000),
			item("torvalds", "subsurface", "C++", 900),
			item("torvalds", "pesconvert", "Go", 60),
		),
	})

	response, body := get(t, server, "/v1/users/torvalds")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.StatusCode, body)
	}

	picked := decodeUser(t, body)
	if picked.Repo.Owner != "torvalds" || picked.Repo.Name != "pesconvert" {
		t.Errorf("picked %s/%s, want the first one in a language we parse",
			picked.Repo.Owner, picked.Repo.Name)
	}
	if picked.Repo.PrimaryLanguage != "Go" || picked.Repo.Stars != 60 {
		t.Errorf("repo = %+v, want its language and stars carried through", picked.Repo)
	}
	// Two were more popular and unreadable. The page says so, because "your most-starred
	// repository" would otherwise be a claim this response cannot support.
	if picked.PassedOver != 2 {
		t.Errorf("passedOver = %d, want 2", picked.PassedOver)
	}
	if picked.Login != "torvalds" || picked.Name != "Linus Torvalds" {
		t.Errorf("user = %+v, want the account GitHub named", picked)
	}
}

func TestUserSpellsTheLoginTheWayGitHubDoes(t *testing.T) {
	server, _ := serveUser(t, map[string]route{
		// Logins are case-insensitive to look up, and the card shows this one.
		"/users/TORVALDS":      {status: 200, body: `{"login":"torvalds","type":"User"}`},
		"/search/repositories": searchResults(item("torvalds", "pesconvert", "Go", 60)),
	})

	_, body := get(t, server, "/v1/users/TORVALDS")
	if picked := decodeUser(t, body); picked.Login != "torvalds" {
		t.Errorf("login = %q, want GitHub's spelling", picked.Login)
	}
}

func TestUnknownAccountIsNotToldAboutRepositories(t *testing.T) {
	server, _ := serveUser(t, map[string]route{})

	response, body := get(t, server, "/v1/users/nobody")
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", response.StatusCode)
	}
	// Someone who mistyped their own username needs to hear that, not a sentence about
	// private repositories looking like missing ones.
	if !strings.Contains(body, "account") || strings.Contains(body, "Private repositories") {
		t.Errorf("body = %s, want the account sentence", body)
	}
}

func TestAccountWithNothingReadableIs422(t *testing.T) {
	server, _ := serveUser(t, map[string]route{
		"/users/torvalds":      {status: 200, body: `{"login":"torvalds","type":"User"}`},
		"/search/repositories": searchResults(item("torvalds", "linux", "C", 190000)),
	})

	response, body := get(t, server, "/v1/users/torvalds")
	if response.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422", response.StatusCode)
	}
	for _, want := range []string{"torvalds", "Go", "Python", "TypeScript"} {
		if !strings.Contains(body, want) {
			t.Errorf("body = %s, want it to name %q", body, want)
		}
	}
}

func TestAccountWithNoRepositoriesIs404(t *testing.T) {
	server, _ := serveUser(t, map[string]route{
		"/users/ada":           {status: 200, body: `{"login":"ada","type":"User"}`},
		"/search/repositories": searchResults(),
	})

	response, body := get(t, server, "/v1/users/ada")
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", response.StatusCode)
	}
	if !strings.Contains(body, "owner/repo") {
		t.Errorf("body = %s, want it to offer the other way in", body)
	}
}

func TestRateLimitOnTheUserLookupIsOursNotTheirs(t *testing.T) {
	server, _ := serveUser(t, map[string]route{
		"/users/ada": {status: 403, header: map[string]string{"X-RateLimit-Remaining": "0"}},
	})

	response, body := get(t, server, "/v1/users/ada")
	if response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", response.StatusCode)
	}
	if strings.Contains(body, "ada") {
		t.Errorf("body = %s, want a spent budget described as ours", body)
	}
}

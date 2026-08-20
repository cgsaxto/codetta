package github

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// avatarServer stands in for avatars.githubusercontent.com. Offline like everything else in
// this package's tests, and reachable only because WithAvatarHost points the allow-list at it.
func avatarServer(t *testing.T, status int, contentType string, body []byte) *httptest.Server {
	t.Helper()

	// TLS, because the client refuses any avatar URL that is not https and that check is
	// worth keeping honest rather than working around.
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "" {
			t.Errorf("avatar request carried an Authorization header: %q", got)
		}
		if got := r.URL.Query().Get("s"); got != "200" {
			t.Errorf("avatar size = %q, want the size the card draws", got)
		}
		if contentType != "" {
			w.Header().Set("Content-Type", contentType)
		}
		w.WriteHeader(status)
		_, _ = w.Write(body)
	}))
	t.Cleanup(server.Close)
	return server
}

// userClient wires an API server and an avatar server together, with the avatar URL the API
// hands back pointing at the second one.
func userClient(t *testing.T, routes map[string]route, avatar *httptest.Server) (*Client, *[]string) {
	t.Helper()

	var seen []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.URL.RequestURI())
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

	opts := []Option{WithBaseURL(server.URL), WithHTTPClient(server.Client())}
	if avatar != nil {
		host, err := url.Parse(avatar.URL)
		if err != nil {
			t.Fatalf("avatar url: %v", err)
		}
		// The avatar server's own client, so its certificate is trusted. It serves the API
		// server too, which is plain http and does not mind.
		opts = append(opts, WithAvatarHost(host.Hostname()), WithHTTPClient(avatar.Client()))
	}
	return New("test-token", opts...), &seen
}

func TestUserInlinesTheAvatar(t *testing.T) {
	avatar := avatarServer(t, 200, "image/png", []byte("\x89PNGfake"))
	client, _ := userClient(t, map[string]route{
		"/users/torvalds": {status: 200, body: `{"login":"torvalds","name":"Linus Torvalds",` +
			`"type":"User","avatar_url":"` + avatar.URL + `/u/1?v=4"}`},
	}, avatar)

	user, err := client.User(context.Background(), "torvalds")
	if err != nil {
		t.Fatalf("User: %v", err)
	}
	if user.Login != "torvalds" || user.Name != "Linus Torvalds" {
		t.Errorf("User = %+v, want the login and name GitHub spelled", user)
	}
	if user.IsOrg {
		t.Error("IsOrg = true for a person")
	}
	if !strings.HasPrefix(user.Avatar, "data:image/png;base64,") {
		t.Errorf("Avatar = %.40q, want a png data uri", user.Avatar)
	}
}

// The avatar is optional in every direction. None of these is an error, because a card
// without a face is still a card and a lookup that fails over a thumbnail is worse than one
// that quietly does without.
func TestUserSurvivesAnUnusableAvatar(t *testing.T) {
	oversized := strings.Repeat("x", maxAvatarBytes+1)

	cases := []struct {
		name        string
		status      int
		contentType string
		body        string
		// elsewhere replaces the avatar URL with one the client must refuse to follow.
		elsewhere string
	}{
		{name: "not an image", status: 200, contentType: "text/html", body: "<html>"},
		{name: "over the cap", status: 200, contentType: "image/png", body: oversized},
		{name: "empty", status: 200, contentType: "image/png", body: ""},
		{name: "missing", status: 404, contentType: "image/png", body: ""},
		{name: "another host", elsewhere: "https://evil.example.com/a.png"},
		{name: "not a url", elsewhere: "://"},
		{name: "absent", elsewhere: " "},
		// Filled in below, since the host has to be the allowed one for this to be about the
		// scheme and nothing else.
		{name: "not https"},
	}

	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			avatar := avatarServer(t, test.status, test.contentType, []byte(test.body))
			source := avatar.URL + "/u/1?v=4"
			if test.name == "not https" {
				source = strings.Replace(source, "https://", "http://", 1)
			} else if test.elsewhere != "" {
				source = strings.TrimSpace(test.elsewhere)
			}

			client, _ := userClient(t, map[string]route{
				"/users/ada": {status: 200, body: `{"login":"ada","type":"User","avatar_url":"` +
					source + `"}`},
			}, avatar)

			user, err := client.User(context.Background(), "ada")
			if err != nil {
				t.Fatalf("User: %v", err)
			}
			if user.Avatar != "" {
				t.Errorf("Avatar = %.40q, want none", user.Avatar)
			}
			if user.Login != "ada" {
				t.Errorf("Login = %q, want the lookup to have succeeded anyway", user.Login)
			}
		})
	}
}

func TestUserRejectsSomethingThatIsNotALogin(t *testing.T) {
	// Every one of these would otherwise reach a query string. The last two are the reason
	// the check exists: a space ends the `user:` qualifier and starts a new one.
	for _, login := range []string{"", "-leading", "trailing-", "has space", "a b:c",
		"has/slash", "has.dot", strings.Repeat("a", 40)} {
		client, seen := userClient(t, map[string]route{}, nil)
		if _, err := client.User(context.Background(), login); !errors.Is(err, ErrNotFound) {
			t.Errorf("User(%q) error = %v, want ErrNotFound", login, err)
		}
		if len(*seen) != 0 {
			t.Errorf("User(%q) reached GitHub at %v", login, *seen)
		}
	}
}

func TestTopReposAsksForTheRightThing(t *testing.T) {
	body := `{"total_count":2,"items":[
		{"name":"linux","owner":{"login":"torvalds"},"language":"C","stargazers_count":9,"default_branch":"master"},
		{"name":"subsurface","owner":{"login":"torvalds"},"language":"C","stargazers_count":2,"default_branch":"main"}
	]}`
	client, seen := userClient(t, map[string]route{
		"/search/repositories": {status: 200, body: body},
	}, nil)

	repos, err := client.TopRepos(context.Background(),
		User{Login: "torvalds"}, 30)
	if err != nil {
		t.Fatalf("TopRepos: %v", err)
	}
	if len(repos) != 2 {
		t.Fatalf("got %d repos, want 2", len(repos))
	}
	if repos[0].Name != "linux" || repos[0].Stars != 9 || repos[0].Ref != "master" {
		t.Errorf("repos[0] = %+v, want linux at its default branch", repos[0])
	}

	query := (*seen)[0]
	for _, want := range []string{"q=user%3Atorvalds+fork%3Afalse", "sort=stars", "order=desc", "per_page=30"} {
		if !strings.Contains(query, want) {
			t.Errorf("query %q is missing %q", query, want)
		}
	}
}

func TestTopReposUsesTheOrgQualifierForAnOrganisation(t *testing.T) {
	client, seen := userClient(t, map[string]route{
		"/search/repositories": {status: 200, body: `{"total_count":0,"items":[]}`},
	}, nil)

	if _, err := client.TopRepos(context.Background(), User{Login: "facebook", IsOrg: true}, 5); err != nil {
		t.Fatalf("TopRepos: %v", err)
	}
	// `user:` and `org:` match different things, which is the only reason the account is
	// looked up before it is searched for.
	if !strings.Contains((*seen)[0], "q=org%3Afacebook") {
		t.Errorf("query %q, want the org qualifier", (*seen)[0])
	}
}

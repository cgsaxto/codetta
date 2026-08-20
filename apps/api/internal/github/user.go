package github

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

/*
Everything this service knows about a person, which is deliberately almost nothing.

Phase 5 asks a visitor for their username and plays them their own code, so the service has
to answer two questions it never had to before: who is this, and which of their repositories
should sound. Neither one needs an account, a session, or anything stored — the answer is
public, it is read once, and it is thrown away with the response.
*/

// DefaultAvatarHost is the only host an avatar may be fetched from. The URL arrives inside
// GitHub's own JSON, which makes it data rather than a constant, and a URL from a response
// is a URL this service must not follow just because it was told to.
const DefaultAvatarHost = "githubusercontent.com"

// avatarPixels is what the card draws it at. GitHub resizes server-side, so asking for the
// size we want is the difference between eight kilobytes and half a megabyte.
const avatarPixels = 200

// maxAvatarBytes bounds a response this service turns around and embeds in its own.
const maxAvatarBytes = 512 << 10

// loginPattern is GitHub's own rule for an account name: alphanumerics and hyphens, 39 max.
//
// Enforced before the name reaches a query string rather than after, because the search
// below puts it inside a `user:` qualifier — an unchecked space would let a visitor append
// qualifiers of their own to a query this service is making with its own token.
var loginPattern = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$`)

// User is a public GitHub account, reduced to what a shareable card can show.
type User struct {
	Login string
	Name  string
	IsOrg bool
	// Avatar is a data URI, or empty when there was not one to be had. Inlined rather than
	// linked so that the browser still never talks to GitHub, and so that the card can be
	// drawn to a canvas and saved — a cross-origin image taints a canvas, and a tainted
	// canvas cannot be turned into a file at all.
	Avatar string
}

type userPayload struct {
	Login     string `json:"login"`
	Name      string `json:"name"`
	Type      string `json:"type"`
	AvatarURL string `json:"avatar_url"`
}

type searchPayload struct {
	TotalCount int `json:"total_count"`
	Items      []struct {
		Name  string `json:"name"`
		Owner struct {
			Login string `json:"login"`
		} `json:"owner"`
		Language      string `json:"language"`
		Stars         int    `json:"stargazers_count"`
		DefaultBranch string `json:"default_branch"`
	} `json:"items"`
}

// User looks up an account. A missing one is ErrNotFound, the same as a missing repository.
func (c *Client) User(ctx context.Context, login string) (User, error) {
	if !loginPattern.MatchString(login) {
		return User{}, fmt.Errorf("%w: %q is not a GitHub username", ErrNotFound, login)
	}

	response, err := c.do(ctx, "/users/"+url.PathEscape(login))
	if err != nil {
		return User{}, err
	}
	defer response.Body.Close()

	var payload userPayload
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return User{}, fmt.Errorf("decoding user: %w", err)
	}
	if payload.Login == "" {
		return User{}, fmt.Errorf("%w: %q", ErrNotFound, login)
	}

	return User{
		// GitHub's spelling, not the visitor's. Logins are case-insensitive to look up and
		// the card shows this one, so it should be the one the account chose.
		Login:  payload.Login,
		Name:   payload.Name,
		IsOrg:  strings.EqualFold(payload.Type, "Organization"),
		Avatar: c.avatar(ctx, payload.AvatarURL),
	}, nil
}

/*
avatar fetches the picture and returns it as a data URI, or "" for any reason at all.

Never an error. A card without a face is a card; a username lookup that fails because an
image did not load is a worse outcome than the one it was protecting against.
*/
func (c *Client) avatar(ctx context.Context, raw string) string {
	if raw == "" {
		return ""
	}

	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" {
		return ""
	}
	host := parsed.Hostname()
	if host != c.avatarHost && !strings.HasSuffix(host, "."+c.avatarHost) {
		return ""
	}

	query := parsed.Query()
	query.Set("s", fmt.Sprint(avatarPixels))
	parsed.RawQuery = query.Encode()

	// No Authorization header: this is a different host, and a token is for the API alone.
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return ""
	}
	response, err := c.http.Do(request)
	if err != nil {
		return ""
	}
	defer response.Body.Close()

	if response.StatusCode != http.StatusOK {
		return ""
	}
	mediaType, _, _ := strings.Cut(response.Header.Get("Content-Type"), ";")
	mediaType = strings.TrimSpace(mediaType)
	if !strings.HasPrefix(mediaType, "image/") {
		return ""
	}

	// One byte past the cap, so a body exactly at it is still whole and one over is refused
	// rather than silently truncated into a broken image.
	body, err := io.ReadAll(io.LimitReader(response.Body, maxAvatarBytes+1))
	if err != nil || len(body) == 0 || len(body) > maxAvatarBytes {
		return ""
	}

	return "data:" + mediaType + ";base64," + base64.StdEncoding.EncodeToString(body)
}

/*
TopRepos returns a user's public repositories, most-starred first.

Through the search endpoint rather than /users/{login}/repos, which cannot sort by stars at
all — it offers created, updated, pushed and full_name, so the alternative is paging every
repository an account has in order to sort them here. One request against a question the API
can already answer beats three against one it cannot.

The cost is that search has its own rate limit, far tighter than the API's. That is not the
drawback it looks like: it is a separate budget, so a burst of username lookups cannot spend
the requests that fetching and parsing a repository needs.

Forks are excluded. Someone's most-starred repository being a fork of a famous one they have
never touched is a true fact about GitHub and a lie about them.
*/
func (c *Client) TopRepos(ctx context.Context, user User, limit int) ([]Repo, error) {
	if !loginPattern.MatchString(user.Login) {
		return nil, fmt.Errorf("%w: %q is not a GitHub username", ErrNotFound, user.Login)
	}

	// `user:` and `org:` are different qualifiers and only one of them matches. Which to use
	// is the reason the account is looked up first rather than searched for directly.
	qualifier := "user:"
	if user.IsOrg {
		qualifier = "org:"
	}

	query := url.Values{}
	query.Set("q", qualifier+user.Login+" fork:false")
	query.Set("sort", "stars")
	query.Set("order", "desc")
	query.Set("per_page", fmt.Sprint(limit))

	response, err := c.do(ctx, "/search/repositories?"+query.Encode())
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()

	var payload searchPayload
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return nil, fmt.Errorf("decoding search: %w", err)
	}

	repos := make([]Repo, 0, len(payload.Items))
	for _, item := range payload.Items {
		if item.Name == "" || item.Owner.Login == "" {
			continue
		}
		repos = append(repos, Repo{
			Owner:           item.Owner.Login,
			Name:            item.Name,
			Ref:             item.DefaultBranch,
			PrimaryLanguage: item.Language,
			Stars:           item.Stars,
		})
	}
	return repos, nil
}

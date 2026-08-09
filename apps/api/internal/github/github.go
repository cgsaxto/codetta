// Package github fetches what this service needs from GitHub, and nothing else: a commit
// SHA, a little repository metadata, and a tarball.
//
// It never clones. docs/features-schema.md allows exactly one way to get source out of
// GitHub — the tarball endpoint — because a clone is unbounded by construction and this
// service has a 25-second budget.
package github

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	DefaultBaseURL = "https://api.github.com"

	// DefaultTimeout is the whole budget from docs/features-schema.md, shared by resolving
	// and downloading. Callers past it get a 504 with a friendly message.
	DefaultTimeout = 25 * time.Second

	acceptJSON = "application/vnd.github+json"
	apiVersion = "2022-11-28"
)

var (
	// ErrNotFound covers both a missing repository and a ref that does not resolve. GitHub
	// returns 404 for a private repository too, so the two are indistinguishable from here.
	ErrNotFound = errors.New("repository or ref not found")

	// ErrRateLimited means the token's hourly budget is spent, not that it is invalid.
	ErrRateLimited = errors.New("github rate limit exhausted")

	// ErrUnauthorized means the token itself was rejected.
	ErrUnauthorized = errors.New("github rejected the token")
)

// Repo is the subset of GitHub's repository data that reaches RepoFeatures.
type Repo struct {
	Owner           string
	Name            string
	Ref             string
	CommitSHA       string
	PrimaryLanguage string
	Stars           int
}

type Client struct {
	baseURL string
	token   string
	http    *http.Client
}

type Option func(*Client)

// WithBaseURL points the client at another host. Tests use it; production does not.
func WithBaseURL(base string) Option {
	return func(c *Client) { c.baseURL = strings.TrimSuffix(base, "/") }
}

func WithHTTPClient(h *http.Client) Option {
	return func(c *Client) { c.http = h }
}

func New(token string, opts ...Option) *Client {
	client := &Client{
		baseURL: DefaultBaseURL,
		token:   token,
		// No Timeout on the client, deliberately.
		//
		// http.Client.Timeout covers the whole exchange including reading the body, so a
		// 25-second one kills a legitimate tarball download that is simply large or on a
		// slow link — which is exactly what it did to facebook/react on a 900 KB/s
		// connection. The budget belongs to the context the caller passes, which is the only
		// thing that knows whether this is a served request or a gallery pre-render.
		http: &http.Client{},
	}
	for _, opt := range opts {
		opt(client)
	}
	return client
}

func (c *Client) do(ctx context.Context, path string) (*http.Response, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+path, nil)
	if err != nil {
		return nil, fmt.Errorf("building request: %w", err)
	}
	request.Header.Set("Accept", acceptJSON)
	request.Header.Set("X-GitHub-Api-Version", apiVersion)
	request.Header.Set("Authorization", "Bearer "+c.token)

	response, err := c.http.Do(request)
	if err != nil {
		return nil, fmt.Errorf("requesting %s: %w", path, err)
	}

	if response.StatusCode >= 400 {
		defer response.Body.Close()
		return nil, classify(response)
	}
	return response, nil
}

// classify turns a GitHub error response into one of this package's sentinels.
//
// 403 and 429 both carry a spent rate limit, and 403 is also what an insufficiently scoped
// token gets — the remaining header is what tells them apart.
func classify(response *http.Response) error {
	switch response.StatusCode {
	case http.StatusNotFound:
		return ErrNotFound
	case http.StatusUnauthorized:
		return ErrUnauthorized
	case http.StatusForbidden, http.StatusTooManyRequests:
		if response.Header.Get("X-RateLimit-Remaining") == "0" {
			return fmt.Errorf("%w: resets at %s",
				ErrRateLimited, response.Header.Get("X-RateLimit-Reset"))
		}
		return ErrUnauthorized
	default:
		return fmt.Errorf("github returned %s", response.Status)
	}
}

type repoPayload struct {
	Language      string `json:"language"`
	Stars         int    `json:"stargazers_count"`
	DefaultBranch string `json:"default_branch"`
}

type commitPayload struct {
	SHA string `json:"sha"`
}

// Resolve turns an owner, name and ref into a commit SHA plus the metadata RepoFeatures
// needs. An empty ref means the repository's default branch.
//
// The SHA matters more than it looks: it is the cache key and the seed, so a branch name
// must be resolved before anything else happens. Branches move; the music must not.
func (c *Client) Resolve(ctx context.Context, owner, name, ref string) (Repo, error) {
	if owner == "" || name == "" {
		return Repo{}, fmt.Errorf("%w: owner and name are required", ErrNotFound)
	}

	response, err := c.do(ctx, "/repos/"+url.PathEscape(owner)+"/"+url.PathEscape(name))
	if err != nil {
		return Repo{}, err
	}
	defer response.Body.Close()

	var meta repoPayload
	if err := json.NewDecoder(response.Body).Decode(&meta); err != nil {
		return Repo{}, fmt.Errorf("decoding repository: %w", err)
	}

	if ref == "" {
		ref = meta.DefaultBranch
	}
	if ref == "" {
		return Repo{}, fmt.Errorf("%w: no ref given and no default branch", ErrNotFound)
	}

	commit, err := c.do(ctx,
		"/repos/"+url.PathEscape(owner)+"/"+url.PathEscape(name)+"/commits/"+url.PathEscape(ref))
	if err != nil {
		return Repo{}, err
	}
	defer commit.Body.Close()

	var head commitPayload
	if err := json.NewDecoder(commit.Body).Decode(&head); err != nil {
		return Repo{}, fmt.Errorf("decoding commit: %w", err)
	}
	if len(head.SHA) != 40 {
		return Repo{}, fmt.Errorf("%w: %q is not a commit sha", ErrNotFound, head.SHA)
	}

	return Repo{
		Owner:           owner,
		Name:            name,
		Ref:             ref,
		CommitSHA:       head.SHA,
		PrimaryLanguage: meta.Language,
		Stars:           meta.Stars,
	}, nil
}

// Tarball opens the archive for a commit. The caller closes it, and is responsible for the
// size cap — this returns a stream precisely so that nothing has to buffer 100 MB to find
// out it was too big.
func (c *Client) Tarball(ctx context.Context, owner, name, sha string) (io.ReadCloser, error) {
	response, err := c.do(ctx,
		"/repos/"+url.PathEscape(owner)+"/"+url.PathEscape(name)+"/tarball/"+url.PathEscape(sha))
	if err != nil {
		return nil, err
	}
	return response.Body, nil
}

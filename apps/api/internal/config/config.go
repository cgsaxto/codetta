// Package config reads the service's environment. It is deliberately tiny: the only thing
// this service needs from the outside is a GitHub token and an address to listen on.
package config

import (
	"errors"
	"fmt"
	"os"
	"strings"
)

// ErrMissingToken is returned when GITHUB_TOKEN is absent or blank.
var ErrMissingToken = errors.New("GITHUB_TOKEN is required")

const defaultAddr = ":8080"

type Config struct {
	// GitHubToken never leaves this process. docs/features-schema.md: the browser never
	// talks to GitHub, and no token crosses the wire to it.
	GitHubToken string
	Addr        string
	// RedisURL is optional by design. docs/features-schema.md: the app must work with Redis
	// down, and a cache that is required at boot is not a cache — it is a dependency.
	RedisURL string
	// SiteDir is apps/web's build output, when this process is also serving it. Empty means
	// API only — which is the development setup, where Vite serves the app.
	SiteDir string
	// TrustProxy says whether X-Forwarded-For was written by something in front of this
	// process. It has to be stated rather than sniffed: trusting it when nothing is in front
	// lets any caller pick their own rate-limit bucket, and not trusting it when something is
	// puts the entire internet in one.
	TrustProxy bool
	// WarmGallery parses the front page's repositories at startup so the first person to
	// paste one is not the person who waits for it. On by default, and pointless without
	// Redis — the warm skips itself in that case rather than spending the budget.
	WarmGallery bool
}

// Load reads the environment, failing if the token is absent.
//
// A hard requirement rather than an optional upgrade. Anonymous GitHub requests are capped
// at sixty an hour, which is enough to look like it works and then fail in the middle of a
// demo — the kind of limit better hit at startup, with an explanation, than at request time.
func Load() (Config, error) {
	token := os.Getenv("GITHUB_TOKEN")
	if token == "" {
		return Config{}, fmt.Errorf(
			"%w: anonymous GitHub requests are limited to 60 an hour, which will not survive "+
				"a single repository. Create a token with no scopes at "+
				"https://github.com/settings/tokens and export GITHUB_TOKEN",
			ErrMissingToken,
		)
	}

	addr := os.Getenv("ADDR")
	if addr == "" {
		addr = defaultAddr
	}

	return Config{
		GitHubToken: token,
		Addr:        addr,
		RedisURL:    os.Getenv("REDIS_URL"),
		SiteDir:     os.Getenv("SITE_DIR"),
		TrustProxy:  flag("TRUST_PROXY", false),
		WarmGallery: flag("WARM_GALLERY", true),
	}, nil
}

// flag reads a boolean the way a person writes one in a compose file or a dashboard. An
// unset variable takes the default; anything unrecognised is treated as unset, because a
// deployment that meant to say something and mistyped it should get the safe answer rather
// than the opposite of what it asked for.
func flag(name string, fallback bool) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(name))) {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		return fallback
	}
}

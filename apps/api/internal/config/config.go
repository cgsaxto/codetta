// Package config reads the service's environment. It is deliberately tiny: the only thing
// this service needs from the outside is a GitHub token and an address to listen on.
package config

import (
	"errors"
	"fmt"
	"os"
)

// ErrMissingToken is returned when GITHUB_TOKEN is absent or blank.
var ErrMissingToken = errors.New("GITHUB_TOKEN is required")

const defaultAddr = ":8080"

type Config struct {
	// GitHubToken never leaves this process. docs/features-schema.md: the browser never
	// talks to GitHub, and no token crosses the wire to it.
	GitHubToken string
	Addr        string
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

	return Config{GitHubToken: token, Addr: addr}, nil
}

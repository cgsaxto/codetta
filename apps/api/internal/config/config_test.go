package config

import (
	"errors"
	"strings"
	"testing"
)

func TestLoadRequiresAToken(t *testing.T) {
	// A hard requirement by choice. Anonymous GitHub allows sixty requests an hour, which is
	// enough to look like it works and then fail halfway through a demo.
	t.Setenv("GITHUB_TOKEN", "")

	_, err := Load()
	if !errors.Is(err, ErrMissingToken) {
		t.Fatalf("err = %v, want ErrMissingToken", err)
	}
	// The message has to say what to do about it, not just what is wrong.
	if !strings.Contains(err.Error(), "github.com/settings/tokens") {
		t.Errorf("error should point at where to get a token, got: %v", err)
	}
}

func TestLoadReadsTheToken(t *testing.T) {
	t.Setenv("GITHUB_TOKEN", "ghp_example")
	t.Setenv("ADDR", "")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.GitHubToken != "ghp_example" {
		t.Errorf("GitHubToken = %q", cfg.GitHubToken)
	}
	if cfg.Addr != defaultAddr {
		t.Errorf("Addr = %q, want %q", cfg.Addr, defaultAddr)
	}
}

func TestLoadHonoursAnExplicitAddress(t *testing.T) {
	t.Setenv("GITHUB_TOKEN", "ghp_example")
	t.Setenv("ADDR", "127.0.0.1:9000")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Addr != "127.0.0.1:9000" {
		t.Errorf("Addr = %q", cfg.Addr)
	}
}

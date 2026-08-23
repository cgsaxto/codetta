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

func TestRedisIsOptional(t *testing.T) {
	// A missing cache is a slower service, not a broken one. Only the token is required.
	t.Setenv("GITHUB_TOKEN", "ghp_example")
	t.Setenv("REDIS_URL", "")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.RedisURL != "" {
		t.Errorf("RedisURL = %q, want empty", cfg.RedisURL)
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

func TestFlagsTakeTheirDefaultsWhenUnset(t *testing.T) {
	t.Setenv("GITHUB_TOKEN", "t")
	t.Setenv("TRUST_PROXY", "")
	t.Setenv("WARM_GALLERY", "")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	// Not trusting a forwarded header is the safe default: trusting one with nothing in front
	// lets any caller choose their own rate-limit bucket.
	if cfg.TrustProxy {
		t.Error("TrustProxy defaulted to true")
	}
	if !cfg.WarmGallery {
		t.Error("WarmGallery defaulted to false; it should be on and skip itself when useless")
	}
}

func TestFlagsReadTheWayPeopleWriteThem(t *testing.T) {
	t.Setenv("GITHUB_TOKEN", "t")

	for _, on := range []string{"1", "true", "TRUE", "yes", "on", " true "} {
		t.Setenv("TRUST_PROXY", on)
		cfg, err := Load()
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		if !cfg.TrustProxy {
			t.Errorf("TRUST_PROXY=%q was not read as true", on)
		}
	}

	for _, off := range []string{"0", "false", "no", "off"} {
		t.Setenv("WARM_GALLERY", off)
		cfg, err := Load()
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		if cfg.WarmGallery {
			t.Errorf("WARM_GALLERY=%q was not read as false", off)
		}
	}
}

func TestAMistypedFlagTakesTheDefaultRatherThanTheOpposite(t *testing.T) {
	// Someone who meant to say something and misspelled it should get the safe answer, not
	// the inverse of what they asked for.
	t.Setenv("GITHUB_TOKEN", "t")
	t.Setenv("TRUST_PROXY", "ture")
	t.Setenv("WARM_GALLERY", "nope")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.TrustProxy || !cfg.WarmGallery {
		t.Errorf("mistyped flags changed the defaults: %+v", cfg)
	}
}

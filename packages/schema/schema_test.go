package schema

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// The Go half of the conformance check.
//
// The fixtures are the shared artifact: TypeScript proves it accepts them by assigning one
// to RepoFeatures under `tsc --noEmit`, and this proves Go round-trips them without losing
// or inventing anything. Between them, a field added to one language and forgotten in the
// other cannot survive.
//
// Strict decoding catches a field the fixtures have that Go does not. Re-encoding and
// comparing catches the reverse — a field Go declares that nothing else knows about shows
// up in the output as a zero value.

func fixturePaths(t *testing.T) []string {
	t.Helper()

	matches, err := filepath.Glob(filepath.Join("..", "..", "fixtures", "*.json"))
	if err != nil {
		t.Fatalf("globbing fixtures: %v", err)
	}

	var paths []string
	for _, path := range matches {
		// *.expected.json holds recorded Scores, which are the music layer's business.
		if strings.HasSuffix(path, ".expected.json") {
			continue
		}
		paths = append(paths, path)
	}
	if len(paths) == 0 {
		t.Fatal("no fixtures found; the conformance check would pass vacuously")
	}
	return paths
}

func decodeStrict(t *testing.T, raw []byte) RepoFeatures {
	t.Helper()

	var features RepoFeatures
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&features); err != nil {
		t.Fatalf("decoding: %v", err)
	}
	return features
}

func TestFixturesRoundTripWithoutLoss(t *testing.T) {
	for _, path := range fixturePaths(t) {
		t.Run(filepath.Base(path), func(t *testing.T) {
			raw, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("reading %s: %v", path, err)
			}

			encoded, err := json.Marshal(decodeStrict(t, raw))
			if err != nil {
				t.Fatalf("encoding: %v", err)
			}

			// Compared as decoded values rather than as bytes: key order and whitespace are
			// not part of the contract, but the set of keys and their values are.
			var before, after map[string]any
			if err := json.Unmarshal(raw, &before); err != nil {
				t.Fatalf("re-reading fixture: %v", err)
			}
			if err := json.Unmarshal(encoded, &after); err != nil {
				t.Fatalf("re-reading output: %v", err)
			}

			if !reflect.DeepEqual(before, after) {
				t.Errorf("round trip changed the document\n before: %v\n  after: %v", before, after)
			}
		})
	}
}

func TestFixturesDeclareTheCurrentSchemaVersion(t *testing.T) {
	for _, path := range fixturePaths(t) {
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("reading %s: %v", path, err)
		}
		if version := decodeStrict(t, raw).SchemaVersion; version != SchemaVersion {
			t.Errorf("%s declares schemaVersion %d, want %d", path, version, SchemaVersion)
		}
	}
}

func TestStrictDecodingRejectsAnUndeclaredField(t *testing.T) {
	// The check that proves the check works. Without DisallowUnknownFields a field added on
	// the TypeScript side would decode silently into nothing at all.
	raw := []byte(`{"schemaVersion":1,"seed":"abc","recentlyInvented":true}`)

	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()

	var features RepoFeatures
	err := decoder.Decode(&features)
	if err == nil {
		t.Fatal("decoded a document with an undeclared field")
	}
	if !strings.Contains(err.Error(), "recentlyInvented") {
		t.Errorf("error should name the offending field, got: %v", err)
	}
}

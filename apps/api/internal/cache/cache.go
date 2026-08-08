// Package cache stores computed RepoFeatures documents in Redis.
//
// The requirement that shapes this package is one sentence in docs/features-schema.md: "The
// app must work with Redis down. Cache miss and cache unavailable take the same path."
//
// So the Cache interface returns no errors. Not as a simplification — as the mechanism. A
// caller that cannot see a Redis failure cannot fail a request because of one, and the rule
// stops depending on every future caller remembering it.
package cache

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"codetta.dev/schema"
	"github.com/redis/go-redis/v9"
)

const (
	// KeyPrefix carries the schema version, so bumping schemaVersion cannot serve documents
	// in the old shape to a client expecting the new one.
	KeyPrefix = "features:v1:"

	// TTL is 30 days, per docs/features-schema.md. A commit's features never change, so the
	// expiry is about bounding storage rather than about freshness.
	TTL = 30 * 24 * time.Hour

	// Timeout is per operation, and it is deliberately short.
	//
	// The whole request has a 25-second budget. A Redis that is wedged rather than down
	// would spend all of it waiting, which is strictly worse than having no cache at all —
	// the point of the cache is to be faster, so it does not get to make anything slower.
	Timeout = 200 * time.Millisecond
)

type Cache interface {
	// Get returns the document and whether it was found. A miss and an outage are the same
	// answer, because they lead to the same work.
	Get(ctx context.Context, commitSHA string) (schema.RepoFeatures, bool)
	// Put stores a document. Failing to store one is not a reason to fail a request that
	// already has its answer.
	Put(ctx context.Context, commitSHA string, features schema.RepoFeatures)
}

// Nop is the cache used when none is configured. Everything still works; it is just slower.
type Nop struct{}

func (Nop) Get(context.Context, string) (schema.RepoFeatures, bool) {
	return schema.RepoFeatures{}, false
}

func (Nop) Put(context.Context, string, schema.RepoFeatures) {}

type Redis struct {
	client *redis.Client
	ttl    time.Duration
	logger *slog.Logger
}

// New returns a cache for the given Redis URL. An empty URL means no cache at all.
//
// It does not ping. A Redis that is down at startup and up ten minutes later should simply
// start working, and requiring it to be present at boot would turn the cache into a
// dependency — which is exactly what the schema doc says it must not be.
func New(url string, logger *slog.Logger) (Cache, error) {
	if url == "" {
		logger.Info("no redis configured, every request will parse from scratch")
		return Nop{}, nil
	}

	options, err := redis.ParseURL(url)
	if err != nil {
		return nil, err
	}
	return &Redis{
		client: redis.NewClient(options),
		ttl:    TTL,
		logger: logger,
	}, nil
}

func (r *Redis) Close() error { return r.client.Close() }

func key(commitSHA string) string { return KeyPrefix + commitSHA }

func (r *Redis) Get(ctx context.Context, commitSHA string) (schema.RepoFeatures, bool) {
	ctx, cancel := context.WithTimeout(ctx, Timeout)
	defer cancel()

	raw, err := r.client.Get(ctx, key(commitSHA)).Bytes()
	if err != nil {
		// A miss is the expected case and not worth a log line; anything else is worth
		// knowing about but is still just a miss.
		if !errors.Is(err, redis.Nil) {
			r.logger.Warn("cache read failed, continuing without it",
				"sha", commitSHA, "error", err)
		}
		return schema.RepoFeatures{}, false
	}

	var features schema.RepoFeatures
	if err := json.Unmarshal(raw, &features); err != nil {
		// A document written by an older build, or a corrupted value. Recomputing is always
		// correct, so this needs no repair path.
		r.logger.Warn("cache held something unreadable", "sha", commitSHA, "error", err)
		return schema.RepoFeatures{}, false
	}
	if features.SchemaVersion != schema.SchemaVersion {
		r.logger.Warn("cache held an older schema version",
			"sha", commitSHA, "found", features.SchemaVersion)
		return schema.RepoFeatures{}, false
	}

	return features, true
}

func (r *Redis) Put(ctx context.Context, commitSHA string, features schema.RepoFeatures) {
	encoded, err := json.Marshal(features)
	if err != nil {
		r.logger.Warn("could not encode document for the cache", "sha", commitSHA, "error", err)
		return
	}

	ctx, cancel := context.WithTimeout(ctx, Timeout)
	defer cancel()

	if err := r.client.Set(ctx, key(commitSHA), encoded, r.ttl).Err(); err != nil {
		r.logger.Warn("cache write failed, the answer is still good",
			"sha", commitSHA, "error", err)
	}
}

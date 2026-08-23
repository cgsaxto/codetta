// Package ratelimit bounds how fast this service will spend the two things it cannot make
// more of: GitHub requests, and the seconds it takes to parse a repository.
//
// Two limits, because they answer different questions. A per-caller limit stops one person
// holding the service open with a script. A single global limit is the one that matters on
// the day the front page arrives, because a thousand people are a thousand addresses and no
// per-caller limit sees them as related — what they share is the token budget.
//
// In memory, per process, and deliberately so. A Redis-backed limiter would be correct
// across replicas and would have to decide what to do when Redis is unavailable; every
// answer to that is wrong here. Failing open means no limit exactly when things are worst,
// and failing closed makes the cache a dependency, which docs/features-schema.md forbids in
// the same breath as it forbids a database.
package ratelimit

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Limiter is a token bucket per key, refilling continuously.
//
// A bucket rather than a counter per window, because a window resets on a boundary that has
// nothing to do with when anyone arrived: two bursts either side of one tick pass a
// sixty-per-minute counter at a hundred and twenty a minute. A bucket has no boundary.
type Limiter struct {
	mu      sync.Mutex
	buckets map[string]*bucket

	// perSecond and burst are the shape of the allowance: the long-run rate, and how much of
	// it may be spent at once.
	perSecond float64
	burst     float64

	// maxKeys is when to sweep, not a ceiling on callers. See sweep.
	maxKeys int

	now func() time.Time
}

type bucket struct {
	tokens float64
	at     time.Time
}

type Option func(*Limiter)

// WithClock replaces time.Now. Tests use it; production does not. Without it, testing a
// refill means sleeping for it, and a test that sleeps is a test nobody runs.
func WithClock(now func() time.Time) Option {
	return func(l *Limiter) { l.now = now }
}

// WithMaxKeys sets the size at which idle buckets are swept.
func WithMaxKeys(keys int) Option {
	return func(l *Limiter) { l.maxKeys = keys }
}

// New returns a limiter allowing perMinute requests per key over the long run, with burst
// available immediately.
func New(perMinute float64, burst int, opts ...Option) *Limiter {
	limiter := &Limiter{
		buckets:   map[string]*bucket{},
		perSecond: perMinute / 60,
		burst:     float64(burst),
		maxKeys:   10_000,
		now:       time.Now,
	}
	for _, opt := range opts {
		opt(limiter)
	}
	return limiter
}

/*
Allow takes a token for key, reporting whether there was one and how long until there is.

The duration is for a Retry-After header. Telling someone to come back is worth little; a
number they can wait out is the difference between a retry and a refresh loop.
*/
func (l *Limiter) Allow(key string) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := l.now()
	held, seen := l.buckets[key]
	if !seen {
		if len(l.buckets) >= l.maxKeys {
			l.sweep(now)
		}
		held = &bucket{tokens: l.burst, at: now}
		l.buckets[key] = held
	}

	// Refilled on read rather than by a ticker: a bucket nobody is using does not need to be
	// woken up to be told it is full.
	elapsed := now.Sub(held.at).Seconds()
	if elapsed > 0 {
		held.tokens = min(l.burst, held.tokens+elapsed*l.perSecond)
		held.at = now
	}

	if held.tokens >= 1 {
		held.tokens--
		return true, 0
	}

	wait := time.Duration((1 - held.tokens) / l.perSecond * float64(time.Second))
	return false, wait
}

/*
sweep drops buckets that are full, which is to say callers who owe nothing.

Deleting a full bucket is free of consequence: the next request from that key creates one
that is also full, which is exactly the state it was in. So the map holds only callers who
are currently spending, and an idle key costs nothing to have forgotten.

It is not a ceiling. If every key in the map is active, the map keeps growing — a few dozen
bytes each — because refusing a caller for being the ten-thousand-and-first is a limit on the
wrong thing.
*/
func (l *Limiter) sweep(now time.Time) {
	for key, held := range l.buckets {
		if held.tokens+now.Sub(held.at).Seconds()*l.perSecond >= l.burst {
			delete(l.buckets, key)
		}
	}
}

// Size reports how many keys are held. For tests and for a log line, not for a decision.
func (l *Limiter) Size() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.buckets)
}

/*
ClientKey identifies the caller for limiting purposes.

trustProxy decides whether X-Forwarded-For is evidence or decoration, and it has to be a
decision rather than a guess. A service reached directly must ignore the header entirely,
because anyone can send one and a limiter keyed on a value the caller chooses is not a
limiter. A service behind exactly one proxy must read it, because otherwise every request
carries the proxy's address and the whole world shares one bucket.

When it is trusted, the rightmost entry is the one to take: the proxy appends the address it
actually saw, and everything to the left of that was supplied by whoever it was talking to.
*/
func ClientKey(r *http.Request, trustProxy bool) string {
	address := r.RemoteAddr

	if trustProxy {
		if forwarded := r.Header.Get("X-Forwarded-For"); forwarded != "" {
			parts := strings.Split(forwarded, ",")
			address = strings.TrimSpace(parts[len(parts)-1])
		}
	}

	host, _, err := net.SplitHostPort(address)
	if err != nil {
		host = address
	}

	return group(host)
}

/*
group folds an address into the unit a person actually is.

An IPv4 address is one caller. An IPv6 address is not: a residential allocation is a /64 at
minimum, so a single machine can source requests from eighteen quintillion distinct
addresses, and a limiter keyed on the full address would hand each of them its own bucket.
The prefix is the thing that is scarce.
*/
func group(host string) string {
	ip := net.ParseIP(host)
	if ip == nil {
		return host
	}
	if v4 := ip.To4(); v4 != nil {
		return v4.String()
	}
	return ip.Mask(net.CIDRMask(64, 128)).String() + "/64"
}

package ratelimit

import (
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// A fake clock throughout. Testing a refill by sleeping for it produces a test nobody runs,
// and one that fails on a loaded machine for reasons unrelated to the code.
type clock struct {
	mu sync.Mutex
	at time.Time
}

func newClock() *clock {
	return &clock{at: time.Date(2026, 8, 23, 12, 0, 0, 0, time.UTC)}
}

func (c *clock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.at
}

func (c *clock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.at = c.at.Add(d)
}

func TestBurstIsSpentThenRefills(t *testing.T) {
	clk := newClock()
	limiter := New(60, 3, WithClock(clk.now))

	for attempt := 1; attempt <= 3; attempt++ {
		if ok, _ := limiter.Allow("a"); !ok {
			t.Fatalf("attempt %d refused, want the burst available at once", attempt)
		}
	}

	ok, wait := limiter.Allow("a")
	if ok {
		t.Fatal("a fourth request passed, want the burst spent")
	}
	// Sixty a minute is one a second, and the caller is told that rather than being told to
	// come back later.
	if wait < 900*time.Millisecond || wait > 1100*time.Millisecond {
		t.Errorf("retry after %v, want about a second", wait)
	}

	clk.advance(1100 * time.Millisecond)
	if ok, _ := limiter.Allow("a"); !ok {
		t.Error("still refused after a second, want one token back")
	}
}

func TestBucketsAreNotSharedBetweenKeys(t *testing.T) {
	clk := newClock()
	limiter := New(60, 1, WithClock(clk.now))

	if ok, _ := limiter.Allow("a"); !ok {
		t.Fatal("first caller refused")
	}
	if ok, _ := limiter.Allow("b"); !ok {
		t.Error("second caller refused because the first had spent its own allowance")
	}
}

func TestRateHoldsOverTheLongRun(t *testing.T) {
	// The property a fixed window does not have: two bursts either side of a boundary pass a
	// sixty-per-minute counter at a hundred and twenty a minute. Here, a minute is sixty.
	clk := newClock()
	limiter := New(60, 10, WithClock(clk.now))

	allowed := 0
	for step := 0; step < 600; step++ {
		if ok, _ := limiter.Allow("a"); ok {
			allowed++
		}
		clk.advance(100 * time.Millisecond)
	}

	// The bucket starts full at the first call, so the span that refills is from the first
	// call to the last: 59.9 seconds, not 60. Ten burst plus 59 whole tokens.
	if allowed != 69 {
		t.Errorf("allowed %d over the run, want 69 (a burst of 10 plus 59.9s of refill)", allowed)
	}
}

func TestSweepForgetsIdleCallersAndKeepsBusyOnes(t *testing.T) {
	clk := newClock()
	limiter := New(60, 2, WithClock(clk.now), WithMaxKeys(3))

	// Two callers who spend nothing they do not immediately get back.
	limiter.Allow("idle-1")
	limiter.Allow("idle-2")
	// One who is still in debt.
	limiter.Allow("busy")
	limiter.Allow("busy")
	limiter.Allow("busy")

	clk.advance(2 * time.Second)

	// The fourth key is what trips the sweep.
	limiter.Allow("newcomer")

	if size := limiter.Size(); size > 2 {
		t.Errorf("holding %d keys after a sweep, want the idle ones dropped", size)
	}
	// Dropping a full bucket changes nothing, which is the whole reason it is safe.
	if ok, _ := limiter.Allow("idle-1"); !ok {
		t.Error("a forgotten caller was refused, want a fresh full bucket")
	}
}

func TestConcurrentCallersDoNotRace(t *testing.T) {
	limiter := New(600, 50)

	var wg sync.WaitGroup
	for worker := 0; worker < 20; worker++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for call := 0; call < 50; call++ {
				limiter.Allow("shared")
			}
		}()
	}
	wg.Wait()
}

func TestClientKeyIgnoresForwardedHeadersWhenNothingIsTrusted(t *testing.T) {
	// A limiter keyed on a value the caller chooses is not a limiter: without a proxy in
	// front, this header is decoration and anyone can rotate it.
	request := httptest.NewRequest(http.MethodGet, "/v1/features/o/r", nil)
	request.RemoteAddr = "203.0.113.9:5555"
	request.Header.Set("X-Forwarded-For", "198.51.100.1")

	if got := ClientKey(request, false); got != "203.0.113.9" {
		t.Errorf("ClientKey = %q, want the address the connection came from", got)
	}
}

func TestClientKeyTakesTheRightmostForwardedEntry(t *testing.T) {
	// The proxy appends what it saw; everything left of that came from whoever it was
	// talking to, and a caller who prepends an address must not get a fresh bucket for it.
	request := httptest.NewRequest(http.MethodGet, "/v1/features/o/r", nil)
	request.RemoteAddr = "10.0.0.7:5555"
	request.Header.Set("X-Forwarded-For", "1.1.1.1, 198.51.100.1")

	if got := ClientKey(request, true); got != "198.51.100.1" {
		t.Errorf("ClientKey = %q, want the entry the trusted proxy added", got)
	}
}

func TestClientKeyGroupsIPv6ByPrefix(t *testing.T) {
	// One machine can source requests from every address in its /64, so the full address is
	// the wrong unit — it would hand a single caller eighteen quintillion buckets.
	first := httptest.NewRequest(http.MethodGet, "/", nil)
	first.RemoteAddr = "[2001:db8:1:2::1]:443"
	second := httptest.NewRequest(http.MethodGet, "/", nil)
	second.RemoteAddr = "[2001:db8:1:2:ffff::9]:443"

	if ClientKey(first, false) != ClientKey(second, false) {
		t.Errorf("%q and %q got separate buckets, want one per /64",
			ClientKey(first, false), ClientKey(second, false))
	}

	other := httptest.NewRequest(http.MethodGet, "/", nil)
	other.RemoteAddr = "[2001:db8:1:3::1]:443"
	if ClientKey(first, false) == ClientKey(other, false) {
		t.Error("two different /64s shared a bucket")
	}
}

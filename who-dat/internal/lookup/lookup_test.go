package lookup

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/lissy93/who-dat/internal/cache"
	"github.com/lissy93/who-dat/internal/domain"
	"github.com/lissy93/who-dat/internal/model"
	"github.com/lissy93/who-dat/internal/srcerr"
)

type fakeSource struct {
	result *model.Result
	err    error
	calls  int
}

func (f *fakeSource) Lookup(context.Context, domain.Name) (*model.Result, error) {
	f.calls++
	return f.result, f.err
}

var testName = domain.Name{ASCII: "example.com", Unicode: "example.com", TLD: "com"}

func TestLookupUsesRDAPFirst(t *testing.T) {
	rdap := &fakeSource{result: model.New("example.com", "example.com", "com")}
	whois := &fakeSource{}
	got, err := NewService(rdap, whois, nil).Lookup(context.Background(), testName)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got == nil || whois.calls != 0 {
		t.Fatalf("expected RDAP result without WHOIS fallback; whois.calls=%d", whois.calls)
	}
}

func TestLookupFallsBackToWHOIS(t *testing.T) {
	rdap := &fakeSource{err: srcerr.ErrNoSource}
	whois := &fakeSource{result: model.New("example.de", "example.de", "de")}
	got, err := NewService(rdap, whois, nil).Lookup(context.Background(), testName)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got == nil || whois.calls != 1 {
		t.Fatalf("expected WHOIS fallback; whois.calls=%d", whois.calls)
	}
}

func TestLookupFallbackErrorIsAnnotated(t *testing.T) {
	rdap := &fakeSource{err: srcerr.ErrNoSource}
	whois := &fakeSource{err: srcerr.ErrTimeout}
	_, err := NewService(rdap, whois, nil).Lookup(context.Background(), testName)

	if !errors.Is(err, srcerr.ErrTimeout) {
		t.Fatalf("err = %v, want ErrTimeout preserved through annotation", err)
	}
	if !strings.Contains(err.Error(), "no rdap server registered for .com") {
		t.Errorf("err = %q, want the missing-RDAP annotation", err)
	}
}

func TestLookupPropagatesUpstreamError(t *testing.T) {
	rdap := &fakeSource{err: srcerr.ErrUpstream}
	whois := &fakeSource{}
	_, err := NewService(rdap, whois, nil).Lookup(context.Background(), testName)
	if !errors.Is(err, srcerr.ErrUpstream) {
		t.Fatalf("err = %v, want ErrUpstream", err)
	}
	if whois.calls != 0 {
		t.Fatal("WHOIS should not be tried on a non-ErrNoSource RDAP error")
	}
}

func TestLookupCacheHit(t *testing.T) {
	rdap := &fakeSource{result: model.New("example.com", "example.com", "com")}
	whois := &fakeSource{}
	svc := NewService(rdap, whois, cache.New(time.Minute))

	if _, err := svc.Lookup(context.Background(), testName); err != nil {
		t.Fatalf("first lookup: %v", err)
	}
	got, err := svc.Lookup(context.Background(), testName)
	if err != nil {
		t.Fatalf("second lookup: %v", err)
	}
	if rdap.calls != 1 {
		t.Errorf("rdap.calls = %d, want 1 (second served from cache)", rdap.calls)
	}
	if !got.Meta.Cached {
		t.Error("cached result should have Meta.Cached = true")
	}
}

// Package lookup orchestrates a domain lookup: cache, then RDAP, then WHOIS fallback.
package lookup

import (
	"context"
	"errors"
	"fmt"

	"github.com/lissy93/who-dat/internal/cache"
	"github.com/lissy93/who-dat/internal/domain"
	"github.com/lissy93/who-dat/internal/model"
	"github.com/lissy93/who-dat/internal/srcerr"
)

// Source is a single lookup backend. The interface lives here, at the consumer, and is
// satisfied by *rdap.Client and *whois.Client.
type Source interface {
	Lookup(ctx context.Context, n domain.Name) (*model.Result, error)
}

// Service resolves a domain via RDAP first, falling back to WHOIS when no RDAP server
// exists for the TLD. Results are cached when a cache is configured.
type Service struct {
	rdap  Source
	whois Source
	cache *cache.Cache // nil when caching is disabled
}

// NewService wires the RDAP and WHOIS sources and an optional cache.
func NewService(rdap, whois Source, c *cache.Cache) *Service {
	return &Service{rdap: rdap, whois: whois, cache: c}
}

// Lookup returns the normalized result for n. A "not registered" answer is a success, not
// an error. On a cache hit the returned result has Meta.Cached set.
func (s *Service) Lookup(ctx context.Context, n domain.Name) (*model.Result, error) {
	if s.cache != nil {
		if cached, ok := s.cache.Get(n.ASCII); ok {
			hit := *cached
			hit.Meta.Cached = true
			return &hit, nil
		}
	}

	r, err := s.rdap.Lookup(ctx, n)
	if errors.Is(err, srcerr.ErrNoSource) {
		if r, err = s.whois.Lookup(ctx, n); err != nil {
			err = fmt.Errorf("no rdap server registered for .%s; fell back to %w", n.TLD, err)
		}
	}
	if err != nil {
		return nil, err
	}

	if s.cache != nil {
		s.cache.Set(n.ASCII, r)
	}
	return r, nil
}

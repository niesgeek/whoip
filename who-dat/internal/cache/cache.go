// Package cache is a small thread-safe TTL cache for lookup results.
package cache

import (
	"sync"
	"time"

	"github.com/lissy93/who-dat/internal/model"
)

type entry struct {
	result    *model.Result
	expiresAt time.Time
}

// Cache stores lookup results keyed by domain, expiring them after a fixed TTL.
type Cache struct {
	mu      sync.RWMutex
	entries map[string]entry
	ttl     time.Duration
	now     func() time.Time
}

// New creates a cache with the given TTL and starts a background sweeper.
func New(ttl time.Duration) *Cache {
	c := &Cache{
		entries: make(map[string]entry),
		ttl:     ttl,
		now:     time.Now,
	}
	go c.sweep()
	return c
}

// Get returns a cached result and true if present and unexpired.
func (c *Cache) Get(key string) (*model.Result, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	e, ok := c.entries[key]
	if !ok || c.now().After(e.expiresAt) {
		return nil, false
	}
	return e.result, true
}

// Set stores a result under key with the cache TTL.
func (c *Cache) Set(key string, r *model.Result) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[key] = entry{result: r, expiresAt: c.now().Add(c.ttl)}
}

func (c *Cache) sweep() {
	ticker := time.NewTicker(c.ttl)
	defer ticker.Stop()
	for range ticker.C {
		now := c.now()
		c.mu.Lock()
		for k, e := range c.entries {
			if now.After(e.expiresAt) {
				delete(c.entries, k)
			}
		}
		c.mu.Unlock()
	}
}

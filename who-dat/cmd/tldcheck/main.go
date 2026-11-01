// Command tldcheck probes live RDAP/WHOIS coverage across every TLD and writes a JSON +
// Markdown report plus a colored console summary. Lookups are throttled per registry host
// and retry on upstream rate-limits, so one busy registry doesn't sink its sibling TLDs.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"math/rand"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/lissy93/who-dat/internal/domain"
	"github.com/lissy93/who-dat/internal/lookup"
	"github.com/lissy93/who-dat/internal/rdap"
	"github.com/lissy93/who-dat/internal/srcerr"
	"github.com/lissy93/who-dat/internal/whois"
)

const (
	perHostConcurrency = 2 // max simultaneous lookups against a single registry host
	maxRetries         = 3 // retries on an upstream rate-limit, never more
	maxBackoff         = 15 * time.Second
)

type report struct {
	Domain       string `json:"domain"`
	TLD          string `json:"tld"`
	Source       string `json:"source"` // rdap, whois, or none
	OK           bool   `json:"ok"`
	IsRegistered bool   `json:"isRegistered"`
	HasDates     bool   `json:"hasDates"`
	Error        string `json:"error,omitempty"`
}

func main() {
	timeout := flag.Duration("timeout", 15*time.Second, "per-domain lookup timeout")
	workers := flag.Int("workers", 16, "max concurrent lookups")
	tldURL := flag.String("tlds", ianaTLDList, "URL of the IANA TLD list")
	domainsFile := flag.String("domains", "", "file with one test domain per line (overrides -tlds)")
	prefix := flag.String("prefix", "nic", "label prefixed to each TLD to form a probe domain")
	limit := flag.Int("limit", 0, "max domains to test (0 = all)")
	jsonOut := flag.String("json", "tld-coverage.json", "JSON output path")
	mdOut := flag.String("md", "tld-coverage.md", "Markdown output path")
	render := flag.String("render", "", "re-render Markdown from an existing JSON report (no probing)")
	recoverPass := flag.Bool("recover", true, "re-probe transient failures once after a cooldown")
	cooldown := flag.Duration("cooldown", 20*time.Second, "wait before the recovery pass")
	flag.Parse()

	if *render != "" {
		reports, err := loadReports(*render)
		if err != nil {
			fmt.Fprintln(os.Stderr, "render:", err)
			os.Exit(1)
		}
		if err := writeMarkdown(*mdOut, reports, 0, time.Now()); err != nil {
			fmt.Fprintln(os.Stderr, "write markdown:", err)
		}
		printSummary(reports)
		return
	}

	httpClient := &http.Client{
		Timeout:   *timeout + 5*time.Second,
		Transport: &http.Transport{TLSClientConfig: rdap.TLSConfig(), ForceAttemptHTTP2: true},
	}

	listCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	domains, err := loadDomains(listCtx, httpClient, *tldURL, *domainsFile, *prefix, *limit)
	if err != nil {
		cancel()
		fmt.Fprintln(os.Stderr, "load domains:", err)
		os.Exit(1)
	}
	hosts, err := fetchRDAPHosts(listCtx, httpClient)
	cancel()
	if err != nil {
		fmt.Fprintln(os.Stderr, "warning: RDAP host map unavailable, per-host throttling reduced:", err)
		hosts = map[string]string{}
	}
	fmt.Printf("Testing %d domains...\n", len(domains))

	svc := lookup.NewService(rdap.NewClient(httpClient), whois.NewClient(), nil)

	start := time.Now()
	reports := run(svc, domains, hosts, *workers, *timeout)
	if *recoverPass {
		reports = recoverTransient(svc, reports, hosts, *workers, *timeout, *cooldown)
	}
	elapsed := time.Since(start)

	sort.Slice(reports, func(i, j int) bool {
		if reports[i].TLD != reports[j].TLD {
			return reports[i].TLD < reports[j].TLD
		}
		return reports[i].Domain < reports[j].Domain
	})

	if err := writeJSON(*jsonOut, reports); err != nil {
		fmt.Fprintln(os.Stderr, "write json:", err)
	}
	if err := writeMarkdown(*mdOut, reports, elapsed, time.Now()); err != nil {
		fmt.Fprintln(os.Stderr, "write markdown:", err)
	}
	printSummary(reports)
}

// run probes every domain through a worker pool. Work is shuffled and each lookup holds a
// per-host slot, so requests to a shared registry backend (e.g. the ~450 TLDs on one host)
// stay throttled instead of all firing at once.
func run(svc *lookup.Service, domains []string, hosts map[string]string, workers int, timeout time.Duration) []report {
	rand.Shuffle(len(domains), func(i, j int) { domains[i], domains[j] = domains[j], domains[i] })

	lim := newHostLimiter(perHostConcurrency)
	jobs := make(chan string)
	results := make(chan report)

	var wg sync.WaitGroup
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for d := range jobs {
				key := hostFor(hosts, strings.ToLower(d))
				if key == "" {
					key = d // no known host: a unique key, so it never blocks a sibling
				}
				lim.acquire(key)
				r := probe(svc, d, timeout)
				lim.release(key)
				results <- r
			}
		}()
	}
	go func() {
		for _, d := range domains {
			jobs <- d
		}
		close(jobs)
	}()
	go func() {
		wg.Wait()
		close(results)
	}()

	out := make([]report, 0, len(domains))
	for r := range results {
		out = append(out, r)
		printLive(len(out), len(domains), r)
	}
	return out
}

// recoverTransient re-probes the domains that failed transiently (rate-limited, upstream,
// timeout) once, after a cooldown, and merges any improved results. Spacing the retry in
// time clears per-minute registry quotas that the inline retry can't.
func recoverTransient(svc *lookup.Service, reports []report, hosts map[string]string, workers int, timeout, cooldown time.Duration) []report {
	var retry []string
	for _, r := range reports {
		if transient(r) {
			retry = append(retry, r.Domain)
		}
	}
	if len(retry) == 0 {
		return reports
	}
	fmt.Printf("\nRecovering %d transient failures after %s cooldown...\n", len(retry), cooldown)
	time.Sleep(cooldown)
	return merge(reports, run(svc, retry, hosts, workers, timeout))
}

// merge overlays updated results onto the originals, keyed by domain.
func merge(base, updates []report) []report {
	byDomain := make(map[string]report, len(updates))
	for _, r := range updates {
		byDomain[r.Domain] = r
	}
	for i, r := range base {
		if u, ok := byDomain[r.Domain]; ok {
			base[i] = u
		}
	}
	return base
}

// probe looks up one domain, retrying on upstream rate-limits up to maxRetries, honoring
// any Retry-After hint.
func probe(svc *lookup.Service, raw string, timeout time.Duration) report {
	r := report{Domain: raw, Source: "none"}
	n, err := domain.Parse(raw)
	if err != nil {
		r.Error = classifyParse(err).String()
		return r
	}
	r.TLD = n.TLD

	for attempt := 0; ; attempt++ {
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		res, err := svc.Lookup(ctx, n)
		cancel()
		if err == nil {
			r.OK = true
			r.Source = res.Meta.Source
			r.IsRegistered = res.IsRegistered
			r.HasDates = res.Dates.Created != nil || res.Dates.Expires != nil
			return r
		}
		var rl *srcerr.RateLimited
		if errors.As(err, &rl) && attempt < maxRetries {
			time.Sleep(backoff(rl.RetryAfter, attempt))
			continue
		}
		r.Error = describe(err)
		return r
	}
}

// backoff waits for the upstream Retry-After when given, otherwise an exponential delay,
// capped so a rude registry can't stall the run.
func backoff(retryAfter time.Duration, attempt int) time.Duration {
	if retryAfter > 0 {
		return min(retryAfter, maxBackoff)
	}
	return min(time.Duration(1<<attempt)*time.Second, maxBackoff)
}

// failKind is a coarse, stable classification of why a probe failed. Grouping and labels
// derive from this enum rather than matching error message text.
type failKind int

const (
	failRateLimited failKind = iota
	failUpstream
	failTimeout
	failNoSource
	failBadProbe // valid-looking, but no registrable domain (wildcard or unlisted TLD)
	failInvalid  // unparseable input
	failOther
)

var failLabels = map[failKind]string{
	failRateLimited: "Rate Limited",
	failUpstream:    "Upstream Error",
	failTimeout:     "Timeout",
	failNoSource:    "No Source",
	failBadProbe:    "No Registrable Domain (wildcard or unlisted TLD)",
	failInvalid:     "Invalid Domain",
	failOther:       "Other",
}

func (k failKind) String() string { return failLabels[k] }

// classifyLookup maps a lookup error to a failure kind.
func classifyLookup(err error) failKind {
	var rl *srcerr.RateLimited
	switch {
	case errors.As(err, &rl):
		return failRateLimited
	case errors.Is(err, srcerr.ErrTimeout), errors.Is(err, context.DeadlineExceeded):
		return failTimeout
	case errors.Is(err, srcerr.ErrNoSource):
		return failNoSource
	case errors.Is(err, srcerr.ErrUpstream):
		return failUpstream
	default:
		return failOther
	}
}

// classifyParse maps a domain.Parse error to a failure kind.
func classifyParse(err error) failKind {
	if errors.Is(err, domain.ErrNoPublicSuffix) {
		return failBadProbe
	}
	return failInvalid
}

// describe is the display string for a lookup error: a stable label, or the raw message
// for unclassified errors so detail isn't lost.
func describe(err error) string {
	if k := classifyLookup(err); k != failOther {
		return k.String()
	}
	return err.Error()
}

// transient reports whether a failed result is worth re-probing (a temporary upstream
// condition rather than a deterministic one).
func transient(r report) bool {
	switch r.Error {
	case failRateLimited.String(), failUpstream.String(), failTimeout.String():
		return true
	default:
		return false
	}
}

// hostLimiter caps concurrent work per key (here, per registry host).
type hostLimiter struct {
	mu   sync.Mutex
	sems map[string]chan struct{}
	max  int
}

func newHostLimiter(max int) *hostLimiter {
	return &hostLimiter{sems: make(map[string]chan struct{}), max: max}
}

func (h *hostLimiter) sem(key string) chan struct{} {
	h.mu.Lock()
	defer h.mu.Unlock()
	s := h.sems[key]
	if s == nil {
		s = make(chan struct{}, h.max)
		h.sems[key] = s
	}
	return s
}

func (h *hostLimiter) acquire(key string) { h.sem(key) <- struct{}{} }
func (h *hostLimiter) release(key string) { <-h.sem(key) }

func writeJSON(path string, reports []report) error {
	b, err := json.MarshalIndent(reports, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o644)
}

func loadReports(path string) ([]report, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var reports []report
	return reports, json.Unmarshal(b, &reports)
}

func writeMarkdown(path string, reports []report, dur time.Duration, gen time.Time) error {
	rdapN, whoisN, failN := counts(reports)

	failBy := map[string][]string{}
	var passRDAP, passWHOIS []string
	for _, r := range reports {
		switch {
		case !r.OK:
			failBy[r.Error] = append(failBy[r.Error], "."+tldLabel(r))
		case r.Source == "whois":
			passWHOIS = append(passWHOIS, "."+tldLabel(r))
		default:
			passRDAP = append(passRDAP, "."+tldLabel(r))
		}
	}

	var b []byte
	gen = gen.UTC()
	b = fmt.Appendf(b, "# Who-Dat TLD Coverage Report\n\n")
	if dur > 0 {
		b = fmt.Appendf(b, "> Generated at %s UTC on %s and took %s.\n", gen.Format("15:04"), gen.Format("2006-01-02"), dur.Round(time.Second))
	} else {
		b = fmt.Appendf(b, "> Generated at %s UTC on %s.\n", gen.Format("15:04"), gen.Format("2006-01-02"))
	}
	b = fmt.Appendf(b, "> Checked %d domains.\n", len(reports))
	b = fmt.Appendf(b, "> Re-run with `make tldcheck`\n\n")

	b = fmt.Appendf(b, "### Summary\n\n")
	b = fmt.Appendf(b, "- ✅ RDAP: **%d**\n- ✅ WHOIS: **%d**\n- ❌ Failed: **%d**\n\n", rdapN, whoisN, failN)
	if failN > 0 {
		b = fmt.Appendf(b, "> Most failures are transient upstream rate-limits or unreachable registries, not gaps in support.\n\n")
	}

	b = fmt.Appendf(b, "### Report\n\n")
	b = fmt.Appendf(b, "| TLD | Source | Registered | OK | Notes |\n|-----|--------|------------|----|-------|\n")
	for _, r := range reports {
		b = fmt.Appendf(b, "| %s | %s | %s | %s | %s |\n",
			tldLabel(r), r.Source, yesNo(r.IsRegistered), status(r.OK), r.Error)
	}
	b = fmt.Appendf(b, "\n")

	if len(failBy) > 0 {
		b = fmt.Appendf(b, "### Failing TLDs\n\n")
		for _, reason := range sortedByCount(failBy) {
			b = details(b, reason, failBy[reason])
		}
	}

	b = fmt.Appendf(b, "### Passing TLDs\n\n")
	b = details(b, "RDAP", passRDAP)
	b = details(b, "WHOIS", passWHOIS)

	return os.WriteFile(path, b, 0o644)
}

// details appends a collapsible <details> block listing the (sorted, wrapped) TLDs. Empty
// groups are skipped.
func details(b []byte, summary string, tlds []string) []byte {
	if len(tlds) == 0 {
		return b
	}
	sort.Strings(tlds)
	return fmt.Appendf(b, "<details>\n<summary>%s (%d)</summary>\n\n```\n%s\n```\n\n</details>\n\n",
		summary, len(tlds), wrapList(tlds, 70))
}

// wrapList joins items with ", " and wraps to lines no longer than width, breaking only at
// commas so the output stays readable without horizontal scrolling.
func wrapList(items []string, width int) string {
	var b strings.Builder
	lineLen := 0
	for i, item := range items {
		token := item
		if i < len(items)-1 {
			token += ","
		}
		switch {
		case lineLen == 0:
			b.WriteString(token)
			lineLen = len(token)
		case lineLen+1+len(token) > width:
			b.WriteByte('\n')
			b.WriteString(token)
			lineLen = len(token)
		default:
			b.WriteByte(' ')
			b.WriteString(token)
			lineLen += 1 + len(token)
		}
	}
	return b.String()
}

// tldLabel is the TLD for a report, falling back to the probe domain's suffix when the
// domain failed to parse (e.g. a TLD newer than the public-suffix list).
func tldLabel(r report) string {
	if r.TLD != "" {
		return r.TLD
	}
	if i := strings.Index(r.Domain, "."); i >= 0 {
		return r.Domain[i+1:]
	}
	return r.Domain
}

func status(ok bool) string {
	if ok {
		return "✅ PASS"
	}
	return "❌ FAIL"
}

func sortedByCount(m map[string][]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		if len(m[keys[i]]) != len(m[keys[j]]) {
			return len(m[keys[i]]) > len(m[keys[j]])
		}
		return keys[i] < keys[j]
	})
	return keys
}

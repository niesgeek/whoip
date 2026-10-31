package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
)

// ianaTLDList is the authoritative list of every current TLD (one per line, uppercase,
// including punycode xn-- TLDs), published by IANA.
const ianaTLDList = "https://data.iana.org/TLD/tlds-alpha-by-domain.txt"

// ianaRDAPBootstrap maps TLDs to their RDAP servers; we use it to throttle per registry host.
const ianaRDAPBootstrap = "https://data.iana.org/rdap/dns.json"

// loadDomains builds the probe list. When domainsFile is set it reads one domain per line;
// otherwise it fetches the IANA TLD list and derives "<prefix>.<tld>" for each TLD.
func loadDomains(ctx context.Context, c *http.Client, tldURL, domainsFile, prefix string, limit int) ([]string, error) {
	var (
		domains []string
		err     error
	)
	if domainsFile != "" {
		domains, err = readLines(domainsFile)
	} else {
		domains, err = fetchTLDs(ctx, c, tldURL, prefix)
	}
	if err != nil {
		return nil, err
	}
	if limit > 0 && limit < len(domains) {
		domains = domains[:limit]
	}
	return domains, nil
}

// fetchTLDs downloads the IANA TLD list and turns each TLD into a probe domain.
func fetchTLDs(ctx context.Context, c *http.Client, url, prefix string) ([]string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch tld list: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("tld list returned status %d", resp.StatusCode)
	}

	var domains []string
	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		tld := strings.TrimSpace(scanner.Text())
		if tld == "" || strings.HasPrefix(tld, "#") {
			continue
		}
		domains = append(domains, prefix+"."+strings.ToLower(tld))
	}
	return domains, scanner.Err()
}

// fetchRDAPHosts builds a TLD -> RDAP host map from the IANA bootstrap, so lookups can be
// throttled per registry backend (many TLDs share one host).
func fetchRDAPHosts(ctx context.Context, c *http.Client) (map[string]string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, ianaRDAPBootstrap, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("rdap bootstrap status %d", resp.StatusCode)
	}

	var reg struct {
		Services [][][]string `json:"services"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&reg); err != nil {
		return nil, err
	}

	hosts := make(map[string]string)
	for _, svc := range reg.Services {
		if len(svc) < 2 || len(svc[1]) == 0 {
			continue
		}
		u, err := url.Parse(svc[1][0])
		if err != nil {
			continue
		}
		for _, tld := range svc[0] {
			hosts[strings.ToLower(tld)] = u.Host
		}
	}
	return hosts, nil
}

// hostFor returns the RDAP host serving a domain, by longest matching TLD suffix.
func hostFor(hosts map[string]string, asciiDomain string) string {
	labels := strings.Split(asciiDomain, ".")
	for i := range labels {
		if h, ok := hosts[strings.Join(labels[i:], ".")]; ok {
			return h
		}
	}
	return ""
}

// readLines reads a file of one domain per line, skipping blanks and # comments.
func readLines(path string) ([]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	var lines []string
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		lines = append(lines, line)
	}
	return lines, scanner.Err()
}

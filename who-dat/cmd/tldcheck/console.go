package main

import (
	"fmt"
	"os"
	"strconv"
)

// ANSI color codes.
const (
	cReset  = "\033[0m"
	cRed    = "\033[31m"
	cGreen  = "\033[32m"
	cYellow = "\033[33m"
	cCyan   = "\033[36m"
	cDim    = "\033[2m"
)

// useColor is true when stdout is a terminal and NO_COLOR is unset.
var useColor = func() bool {
	if os.Getenv("NO_COLOR") != "" {
		return false
	}
	fi, err := os.Stdout.Stat()
	return err == nil && fi.Mode()&os.ModeCharDevice != 0
}()

func color(s, code string) string {
	if !useColor || s == "" {
		return s
	}
	return code + s + cReset
}

// printLive prints one result as it completes, with a running progress counter.
func printLive(n, total int, r report) {
	width := len(strconv.Itoa(total))
	fmt.Printf("[%*d/%d] %s  %-30s %s  %s  %s\n",
		width, n, total, statusTag(r.OK), r.Domain, sourceTag(r.Source), registeredTag(r.IsRegistered), color(r.Error, cDim))
}

// printSummary prints the final tally.
func printSummary(reports []report) {
	rdapN, whoisN, failN := counts(reports)
	fmt.Printf("\nTLD coverage over %d domains:  %s  %s  %s\n",
		len(reports),
		color(fmt.Sprintf("rdap=%d", rdapN), cCyan),
		color(fmt.Sprintf("whois=%d", whoisN), cYellow),
		color(fmt.Sprintf("failed=%d", failN), pick(failN > 0, cRed, cGreen)))
}

func statusTag(ok bool) string {
	if ok {
		return color("PASS", cGreen)
	}
	return color("FAIL", cRed)
}

func sourceTag(src string) string {
	code := cDim
	switch src {
	case "rdap":
		code = cCyan
	case "whois":
		code = cYellow
	}
	return color(fmt.Sprintf("%-5s", src), code)
}

func registeredTag(reg bool) string {
	if reg {
		return color("yes", cGreen)
	}
	return color("no ", cDim)
}

func counts(reports []report) (rdapN, whoisN, failN int) {
	for _, r := range reports {
		switch {
		case !r.OK:
			failN++
		case r.Source == "rdap":
			rdapN++
		case r.Source == "whois":
			whoisN++
		}
	}
	return
}

func yesNo(b bool) string {
	if b {
		return "yes"
	}
	return "no"
}

func pick(cond bool, a, b string) string {
	if cond {
		return a
	}
	return b
}

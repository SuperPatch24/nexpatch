package main

import (
	"bytes"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
)

// InstallResult is the outcome of one NexpatchOnline install script run on this device.
type InstallResult struct {
	ID       string `json:"id"`     // the winget package ID (the log file name)
	Action   string `json:"action"` // install, upgrade or uninstall
	ExitCode int    `json:"exitCode"`
	At       string `json:"at"`
}

var (
	resultLine = regexp.MustCompile(`NEXPATCH-RESULT action=(\w+) exit=(-?\d+)(?: at=(\S+))?`)
	oldLine    = regexp.MustCompile(`winget finished with exit code (-?\d+)`)
)

// decodeLog reads a PowerShell transcript, which may be UTF-8 or UTF-16 (with or without a byte-order mark).
func decodeLog(b []byte) string {
	if len(b) >= 2 && b[0] == 0xFF && b[1] == 0xFE {
		b = b[2:]
		u := make([]uint16, len(b)/2)
		for i := range u {
			u[i] = uint16(b[2*i]) | uint16(b[2*i+1])<<8
		}
		return string(utf16.Decode(u))
	}
	b = bytes.TrimPrefix(b, []byte{0xEF, 0xBB, 0xBF})
	return string(b)
}

// ParseWrapperLog finds the last result in one log. ok is false when the log has no result yet.
func ParseWrapperLog(id, text string, modified time.Time) (InstallResult, bool) {
	if m := resultLine.FindAllStringSubmatch(text, -1); len(m) > 0 {
		last := m[len(m)-1]
		code, _ := strconv.Atoi(last[2])
		at := last[3]
		if _, err := time.Parse(time.RFC3339Nano, at); err != nil {
			at = modified.UTC().Format(time.RFC3339)
		}
		return InstallResult{ID: id, Action: strings.ToLower(last[1]), ExitCode: code, At: at}, true
	}
	if m := oldLine.FindAllStringSubmatch(text, -1); len(m) > 0 {
		code, _ := strconv.Atoi(m[len(m)-1][1])
		return InstallResult{ID: id, Action: "install", ExitCode: code, At: modified.UTC().Format(time.RFC3339)}, true
	}
	return InstallResult{}, false
}

var safeID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$`)

// CollectResults reads every install log changed in the last 30 days (newest result per app), at most 200.
func CollectResults(dir string, now time.Time) []InstallResult {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []InstallResult
	for _, e := range entries {
		if e.IsDir() || !strings.EqualFold(filepath.Ext(e.Name()), ".log") {
			continue
		}
		info, err := e.Info()
		if err != nil || now.Sub(info.ModTime()) > 30*24*time.Hour || info.Size() > 8<<20 {
			continue
		}
		id := strings.TrimSuffix(e.Name(), filepath.Ext(e.Name()))
		if !safeID.MatchString(id) {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		if r, ok := ParseWrapperLog(id, decodeLog(b), info.ModTime()); ok {
			out = append(out, r)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].At > out[j].At })
	if len(out) > 200 {
		out = out[:200]
	}
	return out
}

package main

import (
	"encoding/json"
	"sort"
	"strings"
	"time"
)

const ReportSchema = 1

type App struct {
	Name        string `json:"name"`
	Version     string `json:"version,omitempty"`
	Publisher   string `json:"publisher,omitempty"`
	Scope       string `json:"scope"` // machine or user
	Arch        string `json:"arch"`  // x64 or x86
	InstallDate string `json:"installDate,omitempty"`
	ProductCode string `json:"productCode,omitempty"` // MSI products only
}

type OSInfo struct {
	Product        string `json:"product,omitempty"`
	DisplayVersion string `json:"displayVersion,omitempty"`
	Build          string `json:"build,omitempty"`
	UBR            uint32 `json:"ubr,omitempty"`
	Edition        string `json:"edition,omitempty"`
	Arch           string `json:"arch,omitempty"`
}

type Device struct {
	Name           string `json:"name"`
	IntuneDeviceID string `json:"intuneDeviceId,omitempty"`
	Manufacturer   string `json:"manufacturer,omitempty"`
	Model          string `json:"model,omitempty"`
	OS             OSInfo `json:"os"`
	UptimeHours    int    `json:"uptimeHours,omitempty"`
	RebootPending  bool   `json:"rebootPending"`
	DiskFreeGB     int    `json:"diskFreeGB,omitempty"`
	DiskTotalGB    int    `json:"diskTotalGB,omitempty"`
}

type WingetHealth struct {
	Found               bool   `json:"found"`
	Path                string `json:"path,omitempty"`
	Version             string `json:"version,omitempty"`
	AppInstallerVersion string `json:"appInstallerVersion,omitempty"`
	ExitCode            int    `json:"exitCode"`
	OK                  bool   `json:"ok"`
	Error               string `json:"error,omitempty"`
}

type VCRuntime struct {
	Installed bool   `json:"installed"`
	Version   string `json:"version,omitempty"`
	DLLs      bool   `json:"dlls"`
}

type Health struct {
	Winget    WingetHealth `json:"winget"`
	VCRuntime VCRuntime    `json:"vcRuntime"`
}

type AgentInfo struct {
	Version      string     `json:"version"`
	QueueSize    int        `json:"queueSize"`
	RecentErrors []ErrEntry `json:"recentErrors,omitempty"`
	LogBytes     int64      `json:"logBytes,omitempty"`
}

// Report is what the device sends. A heartbeat leaves out Apps and Results.
type Report struct {
	Schema  int             `json:"schema"`
	Kind    string          `json:"kind"` // full or heartbeat
	SentAt  string          `json:"sentAt"`
	Run     string          `json:"run"`
	Agent   AgentInfo       `json:"agent"`
	Device  Device          `json:"device"`
	Health  Health          `json:"health"`
	Apps    []App           `json:"apps,omitempty"`
	Results []InstallResult `json:"results,omitempty"`
}

// CleanApps removes duplicates, empty names and Windows updates, and sorts by name.
func CleanApps(in []App) []App {
	seen := map[string]bool{}
	var out []App
	for _, a := range in {
		a.Name = strings.TrimSpace(a.Name)
		a.Version = strings.TrimSpace(a.Version)
		if a.Name == "" || len(a.Name) > 200 {
			continue
		}
		low := strings.ToLower(a.Name)
		if strings.HasPrefix(low, "security update for") || strings.HasPrefix(low, "update for microsoft") || strings.HasPrefix(low, "hotfix for") {
			continue
		}
		k := low + "|" + a.Version + "|" + a.Scope + "|" + a.Arch
		if seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, a)
	}
	sort.Slice(out, func(i, j int) bool {
		if strings.EqualFold(out[i].Name, out[j].Name) {
			return out[i].Version < out[j].Version
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	if len(out) > 2000 {
		out = out[:2000]
	}
	return out
}

// InventoryHash changes only when the app list changes, so an unchanged device sends small heartbeats.
func InventoryHash(apps []App, results []InstallResult) string {
	b, _ := json.Marshal(struct {
		A []App
		R []InstallResult
	}{apps, results})
	return sha256Hex(b)
}

// NeedsFull decides between a full report and a heartbeat.
func NeedsFull(s State, hash string, now time.Time) bool {
	if s.LastFullAt == "" || s.InventoryHash != hash {
		return true
	}
	last, err := time.Parse(time.RFC3339, s.LastFullAt)
	if err != nil {
		return true
	}
	every := time.Duration(clampSeconds(s.FullSeconds, 24*3600)) * time.Second
	return now.Sub(last) >= every
}

// Server-suggested intervals are kept within sane limits: 5 minutes to 1 day.
func clampSeconds(v, def int) int {
	if v <= 0 {
		return def
	}
	if v < 300 {
		return 300
	}
	if v > 86400 {
		return 86400
	}
	return v
}

// WindowsProductName fixes the registry's ProductName, which still says Windows 10 on Windows 11.
func WindowsProductName(product, build string) string {
	if n := atoiSafe(build); n >= 22000 {
		return strings.Replace(product, "Windows 10", "Windows 11", 1)
	}
	return product
}

func atoiSafe(s string) int {
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			break
		}
		n = n*10 + int(c-'0')
	}
	return n
}

// Exit codes Windows gives as unsigned numbers are reported as signed, like PowerShell shows them.
func signedExit(code int) int { return int(int32(uint32(code))) }

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var guidRe = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// Config comes from the Intune package. The enrollment key is removed once the device has its own token.
type Config struct {
	Endpoint  string `json:"endpoint"` // e.g. https://nexpatch-api-20022.azurewebsites.net/api/agent/
	TenantID  string `json:"tenantId"`
	EnrollKey string `json:"enrollKey,omitempty"`
	LogLevel  string `json:"logLevel,omitempty"` // debug, info (default), warn, error
}

func (c Config) Validate() error {
	if !guidRe.MatchString(c.TenantID) {
		return errors.New("config.json: tenantId is not a GUID")
	}
	u, err := url.Parse(c.Endpoint)
	if err != nil || u.Host == "" {
		return errors.New("config.json: endpoint is not a valid address")
	}
	if u.Scheme != "https" && !(os.Getenv("NEXPATCH_AGENT_ALLOW_HTTP") == "1" && u.Scheme == "http") {
		return errors.New("config.json: endpoint must use https")
	}
	return nil
}

// URL of one API call, e.g. "enroll" or "report".
func (c Config) URL(name string) string {
	base := c.Endpoint
	if !strings.HasSuffix(base, "/") {
		base += "/"
	}
	return base + name
}

type ErrEntry struct {
	At  string `json:"at"`
	Msg string `json:"msg"`
}

// State is what the agent remembers between runs.
type State struct {
	AgentID          string     `json:"agentId"`
	Token            string     `json:"token,omitempty"`
	IntuneDeviceID   string     `json:"intuneDeviceId,omitempty"`
	EnrolledAt       string     `json:"enrolledAt,omitempty"`
	LastReportAt     string     `json:"lastReportAt,omitempty"`
	LastFullAt       string     `json:"lastFullAt,omitempty"`
	LastAttemptAt    string     `json:"lastAttemptAt,omitempty"`
	InventoryHash    string     `json:"inventoryHash,omitempty"`
	HeartbeatSeconds int        `json:"heartbeatSeconds,omitempty"`
	FullSeconds      int        `json:"fullSeconds,omitempty"`
	Revoked          bool       `json:"revoked,omitempty"`
	RecentErrors     []ErrEntry `json:"recentErrors,omitempty"`
}

func (s *State) AddError(msg string) {
	s.RecentErrors = append(s.RecentErrors, ErrEntry{At: time.Now().UTC().Format(time.RFC3339), Msg: truncate(msg, 300)})
	if len(s.RecentErrors) > 10 {
		s.RecentErrors = s.RecentErrors[len(s.RecentErrors)-10:]
	}
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

func loadJSON(path string, v any) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	b = []byte(strings.TrimPrefix(string(b), "\ufeff")) // tolerate a byte-order mark from Notepad
	return json.Unmarshal(b, v)
}

// Writes atomically, so a power cut never leaves half a file.
func saveJSON(path string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := fmt.Sprintf("%s.%d.tmp", path, time.Now().UnixNano())
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func loadConfig() (Config, error) {
	var c Config
	if err := loadJSON(configPath(), &c); err != nil {
		return c, fmt.Errorf("can't read %s: %w", configPath(), err)
	}
	return c, c.Validate()
}

func loadState() State {
	var s State
	_ = loadJSON(statePath(), &s)
	if !guidRe.MatchString(s.AgentID) {
		s.AgentID = newGUID()
	}
	return s
}

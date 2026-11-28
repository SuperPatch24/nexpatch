package main

import (
	"encoding/json"
	"encoding/xml"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf16"
)

func home(t *testing.T) string {
	t.Helper()
	d := t.TempDir()
	t.Setenv("NEXPATCH_AGENT_HOME", d)
	t.Setenv("NEXPATCH_AGENT_ALLOW_HTTP", "1")
	return d
}

func TestParseWrapperLogNewAndOldFormats(t *testing.T) {
	mod := time.Date(2026, 11, 20, 10, 0, 0, 0, time.UTC)
	r, ok := ParseWrapperLog("Google.Chrome", "x\nwinget finished with exit code -1978335189\nNEXPATCH-RESULT action=install exit=0 at=2026-11-20T09:59:00Z\n", mod)
	if !ok || r.ExitCode != 0 || r.Action != "install" || r.At != "2026-11-20T09:59:00Z" {
		t.Fatalf("new format: %+v %v", r, ok)
	}
	r, ok = ParseWrapperLog("Zoom.Zoom", "winget finished with exit code -1073741701\n", mod)
	if !ok || r.ExitCode != -1073741701 || r.At != "2026-11-20T10:00:00Z" {
		t.Fatalf("old format: %+v", r)
	}
	if _, ok := ParseWrapperLog("x", "nothing here", mod); ok {
		t.Fatal("no result should be found")
	}
	r, _ = ParseWrapperLog("a", "NEXPATCH-RESULT action=install exit=1\nNEXPATCH-RESULT action=uninstall exit=0 at=bad", mod)
	if r.Action != "uninstall" || r.At != "2026-11-20T10:00:00Z" {
		t.Fatalf("last line wins and a bad time falls back to the file time: %+v", r)
	}
}

func TestDecodeLogHandlesUTF16AndBOM(t *testing.T) {
	s := "NEXPATCH-RESULT action=install exit=3010"
	u := utf16.Encode([]rune(s))
	b := []byte{0xFF, 0xFE}
	for _, c := range u {
		b = append(b, byte(c), byte(c>>8))
	}
	if decodeLog(b) != s {
		t.Fatal("UTF-16 transcript not decoded")
	}
	if decodeLog(append([]byte{0xEF, 0xBB, 0xBF}, s...)) != s {
		t.Fatal("UTF-8 BOM not removed")
	}
}

func TestCollectResultsSkipsOldUnsafeAndEmpty(t *testing.T) {
	d := t.TempDir()
	write := func(name, text string, age time.Duration) {
		p := filepath.Join(d, name)
		os.WriteFile(p, []byte(text), 0o600)
		ts := time.Now().Add(-age)
		os.Chtimes(p, ts, ts)
	}
	write("Google.Chrome.log", "NEXPATCH-RESULT action=install exit=0 at=2026-11-25T00:00:00Z", time.Hour)
	write("Old.App.log", "NEXPATCH-RESULT action=install exit=0", 40*24*time.Hour)
	write("Empty.App.log", "still running", time.Hour)
	write("..bad name.log", "NEXPATCH-RESULT action=install exit=0", time.Hour)
	write("notes.txt", "NEXPATCH-RESULT action=install exit=0", time.Hour)
	got := CollectResults(d, time.Now())
	if len(got) != 1 || got[0].ID != "Google.Chrome" {
		t.Fatalf("got %+v", got)
	}
}

func TestQueueKeepsNewestAndFlushesOldestFirst(t *testing.T) {
	q := NewQueue(t.TempDir())
	q.maxItems = 3
	for i := 0; i < 5; i++ {
		q.Add([]byte{byte('a' + i)})
		time.Sleep(2 * time.Millisecond)
	}
	if n := len(q.Items()); n != 3 {
		t.Fatalf("queue should hold 3, has %d", n)
	}
	var seen []string
	fail := false
	n, err := q.Flush(func(b []byte) error {
		if fail {
			return os.ErrDeadlineExceeded
		}
		seen = append(seen, string(b))
		fail = len(seen) == 2
		return nil
	})
	if n != 2 || err == nil || strings.Join(seen, "") != "cd" || len(q.Items()) != 1 {
		t.Fatalf("flush: n=%d err=%v seen=%v left=%d", n, err, seen, len(q.Items()))
	}
}

func TestCleanAppsDropsUpdatesDuplicatesAndSorts(t *testing.T) {
	in := []App{{Name: "zoom", Version: "6"}, {Name: " Google Chrome ", Version: "131"}, {Name: "Google Chrome", Version: "131"},
		{Name: "Security Update for Microsoft Office"}, {Name: ""}, {Name: "7-Zip", Version: "24", Scope: "user"}}
	got := CleanApps(in)
	names := []string{}
	for _, a := range got {
		names = append(names, a.Name)
	}
	if strings.Join(names, ",") != "7-Zip,Google Chrome,zoom" {
		t.Fatalf("got %v", names)
	}
}

func TestNeedsFullAndIntervals(t *testing.T) {
	now := time.Date(2026, 11, 26, 12, 0, 0, 0, time.UTC)
	s := State{LastFullAt: now.Add(-2 * time.Hour).Format(time.RFC3339), InventoryHash: "h"}
	if NeedsFull(s, "h", now) {
		t.Fatal("unchanged and recent: heartbeat only")
	}
	if !NeedsFull(s, "other", now) {
		t.Fatal("changed apps need a full report")
	}
	s.LastFullAt = now.Add(-25 * time.Hour).Format(time.RFC3339)
	if !NeedsFull(s, "h", now) {
		t.Fatal("a full report at least daily")
	}
	if clampSeconds(10, 3600) != 300 || clampSeconds(999999, 3600) != 86400 || clampSeconds(0, 3600) != 3600 {
		t.Fatal("clamp")
	}
}

func TestTaskXMLIsValidRunsAsSystemAndEscapesThePath(t *testing.T) {
	x := TaskXML(`C:\Program Files\A&B\nexpatch-agent.exe`)
	var v struct {
		Principals struct {
			Principal struct{ UserId string } `xml:"Principal"`
		}
		Actions struct {
			Exec struct{ Command, Arguments string }
		}
	}
	if err := xml.Unmarshal([]byte(strings.Replace(x, `encoding="UTF-16"`, `encoding="UTF-8"`, 1)), &v); err != nil {
		t.Fatal(err)
	}
	if v.Principals.Principal.UserId != "S-1-5-18" || v.Actions.Exec.Command != `C:\Program Files\A&B\nexpatch-agent.exe` || v.Actions.Exec.Arguments != "run" {
		t.Fatalf("%+v", v)
	}
	b := utf16File("a\nb")
	if b[0] != 0xFF || b[1] != 0xFE || len(b) != 2+2*4 {
		t.Fatal("UTF-16 file with BOM and CRLF expected")
	}
}

func TestMergeConfigKeepsEnrollmentForSameOrganization(t *testing.T) {
	pkg := Config{TenantID: "11111111-1111-1111-1111-111111111111", Endpoint: "https://x/api/agent/", EnrollKey: "k"}
	same := pkg
	c, fresh := mergeConfig(pkg, &same, State{Token: "t"})
	if fresh || c.EnrollKey != "" {
		t.Fatal("same organization with a token keeps it")
	}
	other := Config{TenantID: "22222222-2222-2222-2222-222222222222"}
	if _, fresh := mergeConfig(pkg, &other, State{Token: "t"}); !fresh {
		t.Fatal("another organization starts over")
	}
	if _, fresh := mergeConfig(pkg, nil, State{}); !fresh {
		t.Fatal("first install enrolls")
	}
}

func TestConfigValidationAndRedaction(t *testing.T) {
	t.Setenv("NEXPATCH_AGENT_ALLOW_HTTP", "")
	if (Config{TenantID: "bad", Endpoint: "https://a"}).Validate() == nil {
		t.Fatal("bad tenant")
	}
	if (Config{TenantID: "11111111-1111-1111-1111-111111111111", Endpoint: "http://a"}).Validate() == nil {
		t.Fatal("http refused")
	}
	if (Config{TenantID: "11111111-1111-1111-1111-111111111111", Endpoint: "https://a/api/agent"}).URL("report") != "https://a/api/agent/report" {
		t.Fatal("url")
	}
	out := string(redact([]byte(`{"token": "secret1", "enrollKey":"secret2", "agentId":"x"}`)))
	if strings.Contains(out, "secret") || !strings.Contains(out, `"agentId":"x"`) {
		t.Fatal(out)
	}
}

func TestLoggerWritesJSONAndRotates(t *testing.T) {
	d := t.TempDir()
	l := NewLogger(d, "info", false)
	l.maxBytes, l.keep = 300, 3
	l.Debug("hidden")
	for i := 0; i < 20; i++ {
		l.Info("hello", "n", i, "err", os.ErrNotExist)
	}
	l.Close()
	files, _ := filepath.Glob(filepath.Join(d, "agent*.log"))
	if len(files) > 3 {
		t.Fatalf("kept %d files", len(files))
	}
	b, _ := os.ReadFile(filepath.Join(d, "agent.1.log"))
	line := strings.SplitN(string(b), "\n", 2)[0]
	var rec map[string]any
	if json.Unmarshal([]byte(line), &rec) != nil || rec["msg"] != "hello" || rec["level"] != "info" || rec["run"] == "" || rec["err"] != "file does not exist" {
		t.Fatalf("bad line %q", line)
	}
	if strings.Contains(string(b), "hidden") {
		t.Fatal("debug lines must not be written at info level")
	}
}

func TestVersionsAndNames(t *testing.T) {
	if compareVersions("1.24.25200.0", "1.9.9") <= 0 || compareVersions("1.0", "1.0.0") != 0 {
		t.Fatal("compare")
	}
	if WindowsProductName("Windows 10 Pro", "22631") != "Windows 11 Pro" || WindowsProductName("Windows 10 Pro", "19045") != "Windows 10 Pro" {
		t.Fatal("product name")
	}
	if signedExit(3221225595) != -1073741701 {
		t.Fatal("signed exit")
	}
	if !strings.Contains(WingetStartProblem(-1073741701), "Visual C++") {
		t.Fatal("explain")
	}
}

// End to end against a fake NexpatchOnline: enroll once, drop the key, report, survive an outage, get revoked.
func TestEndToEnd(t *testing.T) {
	home(t)
	t.Setenv("NEXPATCH_TEST_INTUNE_ID", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
	var mu sync.Mutex
	down, revoked := false, false
	var reports []Report
	enrolls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if r.Header.Get("x-nexpatch-tenant") != "11111111-1111-1111-1111-111111111111" {
			w.WriteHeader(400)
			return
		}
		switch r.URL.Path {
		case "/api/agent/enroll":
			if r.Header.Get("x-nexpatch-key") != "the-key" {
				w.WriteHeader(401)
				json.NewEncoder(w).Encode(map[string]string{"error": "Unknown organization or key."})
				return
			}
			enrolls++
			json.NewEncoder(w).Encode(map[string]any{"token": "tok", "heartbeatSeconds": 1800})
		case "/api/agent/report":
			if down {
				w.WriteHeader(503)
				return
			}
			if revoked {
				w.WriteHeader(403)
				json.NewEncoder(w).Encode(map[string]string{"error": "An admin revoked this device."})
				return
			}
			if r.Header.Get("x-nexpatch-token") != "tok" {
				w.WriteHeader(401)
				return
			}
			var rep Report
			json.NewDecoder(r.Body).Decode(&rep)
			reports = append(reports, rep)
			json.NewEncoder(w).Encode(map[string]any{"heartbeatSeconds": 900})
		}
	}))
	defer srv.Close()
	os.MkdirAll(dataDir(), 0o700)
	saveJSON(configPath(), Config{Endpoint: srv.URL + "/api/agent/", TenantID: "11111111-1111-1111-1111-111111111111", EnrollKey: "the-key"})
	os.MkdirAll(wrapperLogDir(), 0o700)
	os.WriteFile(filepath.Join(wrapperLogDir(), "Google.Chrome.log"), []byte("NEXPATCH-RESULT action=install exit=0"), 0o600)

	a, err := openAgent(false)
	if err != nil {
		t.Fatal(err)
	}
	wait, err := a.cycle(false)
	if err != nil || wait != 900*time.Second || enrolls != 1 || len(reports) != 1 || reports[0].Kind != "full" || len(reports[0].Results) != 1 {
		t.Fatalf("first cycle: wait=%v err=%v enrolls=%d reports=%d", wait, err, enrolls, len(reports))
	}
	var cfg Config
	loadJSON(configPath(), &cfg)
	if cfg.EnrollKey != "" {
		t.Fatal("the enrollment key must be removed after enrolling")
	}
	if reports[0].Device.IntuneDeviceID != "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" {
		t.Fatal("intune id")
	}
	// Nothing changed: heartbeat only
	a.cycle(false)
	if reports[1].Kind != "heartbeat" || reports[1].Apps != nil {
		t.Fatal("second report should be a heartbeat")
	}
	// Outage: a full report is saved and sent later
	mu.Lock()
	down = true
	mu.Unlock()
	if _, err := a.cycle(true); err == nil || len(a.queue.Items()) != 1 {
		t.Fatalf("outage should queue: err=%v queued=%d", err, len(a.queue.Items()))
	}
	mu.Lock()
	down = false
	mu.Unlock()
	a.cycle(false)
	if len(a.queue.Items()) != 0 || len(reports) != 4 {
		t.Fatalf("queue should flush: left=%d reports=%d", len(a.queue.Items()), len(reports))
	}
	// Revoked: the agent stops trying
	mu.Lock()
	revoked = true
	mu.Unlock()
	wait, _ = a.cycle(false)
	if !a.state.Revoked || wait != 6*time.Hour {
		t.Fatalf("revoked: %v %v", a.state.Revoked, wait)
	}
	reread := loadState()
	if !reread.Revoked || reread.Token != "tok" || len(reread.RecentErrors) == 0 {
		t.Fatal("state should be saved with the error")
	}
}

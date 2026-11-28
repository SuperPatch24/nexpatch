package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"math/rand"
	"os"
	"strings"
	"time"
)

// agentCtx holds everything one process needs.
type agentCtx struct {
	cfg   Config
	state State
	log   *Logger
	api   *Client
	queue *Queue
}

func openAgent(echo bool) (*agentCtx, error) {
	cfg, err := loadConfig()
	lvl := "info"
	if err == nil && cfg.LogLevel != "" {
		lvl = cfg.LogLevel
	}
	a := &agentCtx{cfg: cfg, state: loadState(), log: NewLogger(logDir(), lvl, echo), queue: NewQueue(queueDir())}
	if err != nil {
		a.log.Error("configuration problem", "err", err)
		return a, err
	}
	a.api = NewClient(cfg)
	return a, nil
}

func (a *agentCtx) save() {
	if err := saveJSON(statePath(), a.state); err != nil {
		a.log.Error("can't save state", "err", err)
	}
}

// ensureEnrolled exchanges the enrollment key for this device's own token, then removes the key from disk.
func (a *agentCtx) ensureEnrolled(d Device) error {
	if a.state.Token != "" {
		return nil
	}
	if err := a.api.Enroll(&a.state, d); err != nil {
		return err
	}
	a.log.Info("enrolled with NexpatchOnline", "agentId", a.state.AgentID, "intuneDeviceId", d.IntuneDeviceID)
	a.cfg.EnrollKey = ""
	if err := saveJSON(configPath(), a.cfg); err != nil {
		a.log.Warn("couldn't remove the enrollment key from config.json", "err", err)
	}
	a.save()
	return nil
}

// buildReport collects everything. full=false gives a heartbeat without the app list.
func (a *agentCtx) buildReport(forceFull bool) (Report, bool, string) {
	now := time.Now().UTC()
	d := collectDevice()
	a.log.SetDevice(d.Name)
	h := collectHealth()
	apps := collectApps()
	results := CollectResults(wrapperLogDir(), now)
	hash := InventoryHash(apps, results)
	full := forceFull || NeedsFull(a.state, hash, now)
	r := Report{Schema: ReportSchema, Kind: "heartbeat", SentAt: now.Format(time.RFC3339), Run: a.log.run, Device: d, Health: h,
		Agent: AgentInfo{Version: AgentVersion, QueueSize: len(a.queue.Items()), RecentErrors: a.state.RecentErrors}}
	if st, err := os.Stat(a.log.path(0)); err == nil {
		r.Agent.LogBytes = st.Size()
	}
	if full {
		r.Kind, r.Apps, r.Results = "full", apps, results
	}
	return r, full, hash
}

// cycle runs one collect-and-send. It returns how long to wait before the next one.
func (a *agentCtx) cycle(forceFull bool) (time.Duration, error) {
	hb := time.Duration(clampSeconds(a.state.HeartbeatSeconds, 3600)) * time.Second
	if a.state.Revoked {
		return 6 * time.Hour, errors.New("an administrator revoked this device in NexpatchOnline; reinstall the agent to enroll again")
	}
	r, full, hash := a.buildReport(forceFull)
	if err := a.ensureEnrolled(r.Device); err != nil {
		return a.backoff(err, hb)
	}
	body, _ := json.Marshal(r)
	a.state.LastAttemptAt = r.SentAt
	reply, err := a.api.Report(&a.state, body)
	if err != nil {
		if full {
			if qerr := a.queue.Add(body); qerr == nil {
				a.log.Warn("report saved to send later", "queued", len(a.queue.Items()))
			}
		}
		return a.backoff(err, hb)
	}
	a.state.LastReportAt = r.SentAt
	if full {
		a.state.LastFullAt, a.state.InventoryHash = r.SentAt, hash
	}
	if reply.HeartbeatSeconds > 0 {
		a.state.HeartbeatSeconds = reply.HeartbeatSeconds
	}
	if reply.FullSeconds > 0 {
		a.state.FullSeconds = reply.FullSeconds
	}
	a.log.Info("report sent", "kind", r.Kind, "apps", len(r.Apps), "results", len(r.Results), "wingetOk", r.Health.Winget.OK)
	if n, err := a.queue.Flush(func(b []byte) error { _, e := a.api.Report(&a.state, b); return e }); n > 0 || err != nil {
		a.log.Info("sent saved reports", "sent", n, "left", len(a.queue.Items()))
	}
	a.save()
	return time.Duration(clampSeconds(a.state.HeartbeatSeconds, 3600)) * time.Second, nil
}

// backoff records the error and decides the next attempt: revoked devices stop, rate limits are respected,
// anything else waits 5 minutes, then 15, then the normal interval.
func (a *agentCtx) backoff(err error, normal time.Duration) (time.Duration, error) {
	a.state.AddError(err.Error())
	var ae *APIError
	wait := 5 * time.Minute
	if errors.As(err, &ae) {
		switch {
		case ae.Status == 401 && a.state.Token != "":
			a.log.Warn("NexpatchOnline doesn't recognise this device's token; enrolling again")
			a.state.Token = ""
		case ae.Status == 403 && strings.Contains(strings.ToLower(ae.Message), "revoked"):
			a.state.Revoked = true
			wait = 6 * time.Hour
		case ae.Status == 429 && ae.RetryAfter > 0:
			wait = ae.RetryAfter
		case ae.Status >= 500:
			wait = 15 * time.Minute
		default:
			wait = normal
		}
	}
	a.log.Error("report failed", "err", err, "retryInMinutes", int(wait.Minutes()))
	a.save()
	return wait, err
}

func cmdRun() int {
	if !singleInstance() {
		fmt.Println("The agent is already running.")
		return 0
	}
	a, err := openAgent(false)
	if err != nil {
		time.Sleep(30 * time.Minute) // the scheduled task restarts us; don't spin
		return 1
	}
	defer a.log.Close()
	a.log.Info("agent started", "pid", os.Getpid())
	time.Sleep(time.Duration(rand.Intn(90)) * time.Second) // spread devices that boot together
	for {
		wait, _ := a.cycle(false)
		time.Sleep(wait)
	}
}

func cmdOnce() int {
	a, err := openAgent(true)
	if err != nil {
		fmt.Println("Error:", err)
		return 1
	}
	defer a.log.Close()
	if _, err := a.cycle(true); err != nil {
		fmt.Println("Error:", err)
		return 1
	}
	fmt.Println("Sent a full report to NexpatchOnline.")
	return 0
}

func cmdStatus() int {
	a, cfgErr := openAgent(false)
	defer a.log.Close()
	h := collectHealth()
	out := map[string]any{
		"version": AgentVersion, "agentId": a.state.AgentID, "enrolled": a.state.Token != "", "revoked": a.state.Revoked,
		"lastReportAt": a.state.LastReportAt, "lastFullAt": a.state.LastFullAt, "lastAttemptAt": a.state.LastAttemptAt,
		"queuedReports": len(a.queue.Items()), "recentErrors": a.state.RecentErrors,
		"winget": h.Winget, "vcRuntime": h.VCRuntime, "dataFolder": dataDir(),
	}
	if cfgErr != nil {
		out["configError"] = cfgErr.Error()
	} else {
		out["endpoint"] = a.cfg.Endpoint
		out["tenantId"] = a.cfg.TenantID
	}
	b, _ := json.MarshalIndent(out, "", "  ")
	fmt.Println(string(b))
	if cfgErr != nil || a.state.Revoked {
		return 1
	}
	return 0
}

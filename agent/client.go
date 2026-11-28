package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// APIError carries the status so the loop can tell "try later" from "this device was revoked".
type APIError struct {
	Status     int
	Message    string
	RetryAfter time.Duration
}

func (e *APIError) Error() string {
	return fmt.Sprintf("NexpatchOnline answered %d: %s", e.Status, e.Message)
}

type Client struct {
	cfg  Config
	http *http.Client
}

func NewClient(cfg Config) *Client {
	return &Client{cfg: cfg, http: &http.Client{Timeout: 60 * time.Second}}
}

func (c *Client) post(name string, headers map[string]string, body []byte, out any) error {
	req, err := http.NewRequest("POST", c.cfg.URL(name), bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "NexpatchOnline-Agent/"+AgentVersion)
	req.Header.Set("x-nexpatch-tenant", c.cfg.TenantID)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode >= 300 {
		var e struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(data, &e)
		if e.Error == "" {
			e.Error = http.StatusText(res.StatusCode)
		}
		ra, _ := strconv.Atoi(res.Header.Get("retry-after"))
		return &APIError{Status: res.StatusCode, Message: truncate(e.Error, 300), RetryAfter: time.Duration(ra) * time.Second}
	}
	if out != nil && len(data) > 0 {
		return json.Unmarshal(data, out)
	}
	return nil
}

type enrollReply struct {
	Token            string `json:"token"`
	HeartbeatSeconds int    `json:"heartbeatSeconds"`
	FullSeconds      int    `json:"fullSeconds"`
}

func (c *Client) Enroll(s *State, d Device) error {
	if c.cfg.EnrollKey == "" {
		return errors.New("no enrollment key in config.json; redeploy the agent from NexpatchOnline")
	}
	body, _ := json.Marshal(map[string]any{"agentId": s.AgentID, "intuneDeviceId": d.IntuneDeviceID, "deviceName": d.Name, "agentVersion": AgentVersion})
	var r enrollReply
	if err := c.post("enroll", map[string]string{"x-nexpatch-key": c.cfg.EnrollKey}, body, &r); err != nil {
		return err
	}
	if r.Token == "" {
		return errors.New("NexpatchOnline didn't return a token")
	}
	s.Token, s.IntuneDeviceID, s.EnrolledAt = r.Token, d.IntuneDeviceID, time.Now().UTC().Format(time.RFC3339)
	s.HeartbeatSeconds, s.FullSeconds = r.HeartbeatSeconds, r.FullSeconds
	return nil
}

type reportReply struct {
	HeartbeatSeconds int `json:"heartbeatSeconds"`
	FullSeconds      int `json:"fullSeconds"`
}

func (c *Client) Report(s *State, body []byte) (reportReply, error) {
	var r reportReply
	err := c.post("report", map[string]string{"x-nexpatch-agent": s.AgentID, "x-nexpatch-token": s.Token}, body, &r)
	return r, err
}

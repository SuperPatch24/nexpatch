package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Queue keeps full reports that couldn't be sent (no network, API down), so nothing is lost while offline.
// It holds at most maxItems files and drops anything older than maxAge.
type Queue struct {
	dir      string
	maxItems int
	maxAge   time.Duration
}

func NewQueue(dir string) *Queue { return &Queue{dir: dir, maxItems: 20, maxAge: 7 * 24 * time.Hour} }

func (q *Queue) Add(body []byte) error {
	if err := os.MkdirAll(q.dir, 0o700); err != nil {
		return err
	}
	name := filepath.Join(q.dir, fmt.Sprintf("%d-%s.json", time.Now().UTC().UnixNano(), randomRunID()))
	if err := os.WriteFile(name, body, 0o600); err != nil {
		return err
	}
	q.trim(time.Now())
	return nil
}

// Items returns queued files, oldest first.
func (q *Queue) Items() []string {
	entries, err := os.ReadDir(q.dir)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".json") {
			out = append(out, filepath.Join(q.dir, e.Name()))
		}
	}
	sort.Strings(out) // names start with the time, so this is oldest first
	return out
}

func (q *Queue) trim(now time.Time) {
	items := q.Items()
	for i, p := range items {
		info, err := os.Stat(p)
		tooMany := len(items)-i > q.maxItems
		if err != nil || tooMany || now.Sub(info.ModTime()) > q.maxAge {
			_ = os.Remove(p)
		}
	}
}

// Flush sends queued reports oldest first and stops at the first failure. Returns how many were sent.
func (q *Queue) Flush(send func([]byte) error) (int, error) {
	q.trim(time.Now())
	sent := 0
	for _, p := range q.Items() {
		b, err := os.ReadFile(p)
		if err != nil {
			_ = os.Remove(p)
			continue
		}
		if err := send(b); err != nil {
			return sent, err
		}
		_ = os.Remove(p)
		sent++
	}
	return sent, nil
}

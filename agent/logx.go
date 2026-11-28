package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Logger writes one JSON object per line to logs\agent.log and keeps the newest few files.
// Every line has the time, level, run ID and device, so a support person can follow one run across files.
type Logger struct {
	mu       sync.Mutex
	dir      string
	maxBytes int64
	keep     int
	level    int
	run      string
	device   string
	echo     bool // also print to the console (interactive commands)
	f        *os.File
	size     int64
}

var levels = map[string]int{"debug": 0, "info": 1, "warn": 2, "error": 3}

func NewLogger(dir, level string, echo bool) *Logger {
	l := &Logger{dir: dir, maxBytes: 5 << 20, keep: 5, level: 1, run: randomRunID(), echo: echo}
	if v, ok := levels[strings.ToLower(level)]; ok {
		l.level = v
	}
	return l
}

func (l *Logger) SetDevice(d string) { l.mu.Lock(); l.device = d; l.mu.Unlock() }

func (l *Logger) Debug(msg string, kv ...any) { l.write("debug", msg, kv) }
func (l *Logger) Info(msg string, kv ...any)  { l.write("info", msg, kv) }
func (l *Logger) Warn(msg string, kv ...any)  { l.write("warn", msg, kv) }
func (l *Logger) Error(msg string, kv ...any) { l.write("error", msg, kv) }

func (l *Logger) write(level, msg string, kv []any) {
	if levels[level] < l.level {
		return
	}
	rec := map[string]any{"time": time.Now().UTC().Format(time.RFC3339Nano), "level": level, "msg": msg, "run": l.run, "version": AgentVersion}
	if l.device != "" {
		rec["device"] = l.device
	}
	for i := 0; i+1 < len(kv); i += 2 {
		k := fmt.Sprint(kv[i])
		if k == "time" || k == "level" || k == "msg" || k == "run" {
			k = "x_" + k
		}
		if err, ok := kv[i+1].(error); ok {
			rec[k] = err.Error()
		} else {
			rec[k] = kv[i+1]
		}
	}
	line, _ := json.Marshal(rec)
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.echo {
		fmt.Printf("%-5s %s%s\n", strings.ToUpper(level), msg, kvText(kv))
	}
	if err := l.open(); err != nil {
		return
	}
	n, _ := l.f.Write(append(line, '\n'))
	l.size += int64(n)
	if l.size >= l.maxBytes {
		l.rotate()
	}
}

func kvText(kv []any) string {
	var b strings.Builder
	for i := 0; i+1 < len(kv); i += 2 {
		fmt.Fprintf(&b, " %v=%v", kv[i], kv[i+1])
	}
	return b.String()
}

func (l *Logger) path(i int) string {
	if i == 0 {
		return filepath.Join(l.dir, "agent.log")
	}
	return filepath.Join(l.dir, fmt.Sprintf("agent.%d.log", i))
}

func (l *Logger) open() error {
	if l.f != nil {
		return nil
	}
	if err := os.MkdirAll(l.dir, 0o700); err != nil {
		return err
	}
	f, err := os.OpenFile(l.path(0), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	st, _ := f.Stat()
	l.f, l.size = f, st.Size()
	return nil
}

// agent.log -> agent.1.log -> ... ; the oldest is deleted.
func (l *Logger) rotate() {
	if l.f != nil {
		l.f.Close()
		l.f = nil
	}
	_ = os.Remove(l.path(l.keep - 1))
	for i := l.keep - 2; i >= 0; i-- {
		_ = os.Rename(l.path(i), l.path(i+1))
	}
	l.size = 0
}

func (l *Logger) Close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.f != nil {
		l.f.Close()
		l.f = nil
	}
}

// Tail returns the last n lines of the current log (for status and diag).
func (l *Logger) Tail(n int) []string {
	b, err := os.ReadFile(l.path(0))
	if err != nil {
		return nil
	}
	lines := strings.Split(strings.TrimRight(string(b), "\n"), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return lines
}

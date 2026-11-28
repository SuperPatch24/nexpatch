package main

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"time"
)

var secretField = regexp.MustCompile(`(?i)"(token|enrollKey)"\s*:\s*"[^"]*"`)

// redact removes secrets before anything leaves the device in a support bundle.
func redact(b []byte) []byte { return secretField.ReplaceAll(b, []byte(`"$1":"(removed)"`)) }

func cmdDiag() int {
	name := filepath.Join(dataDir(), "diag-"+time.Now().Format("20060102-150405")+".zip")
	f, err := os.Create(name)
	if err != nil {
		fmt.Println("Error:", err)
		return 1
	}
	z := zip.NewWriter(f)
	add := func(n string, b []byte) {
		if w, err := z.Create(n); err == nil {
			_, _ = w.Write(b)
		}
	}
	for _, p := range []string{configPath(), statePath()} {
		if b, err := os.ReadFile(p); err == nil {
			add(filepath.Base(p), redact(b))
		}
	}
	logs, _ := filepath.Glob(filepath.Join(logDir(), "agent*.log"))
	for _, p := range logs {
		if b, err := os.ReadFile(p); err == nil {
			add("logs/"+filepath.Base(p), redact(b))
		}
	}
	snap := map[string]any{"device": collectDevice(), "health": collectHealth(), "apps": collectApps(), "results": CollectResults(wrapperLogDir(), time.Now()), "queued": len(NewQueue(queueDir()).Items())}
	b, _ := json.MarshalIndent(snap, "", "  ")
	add("snapshot.json", b)
	if err := z.Close(); err != nil {
		fmt.Println("Error:", err)
		return 1
	}
	f.Close()
	fmt.Println("Support bundle written to", name)
	fmt.Println("Tokens and keys are removed. Send this file to NexpatchOnline support if asked.")
	return 0
}

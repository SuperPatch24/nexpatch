package main

import (
	"os"
	"path/filepath"
)

// Where the agent lives. NEXPATCH_AGENT_HOME moves everything (used by tests).
func programDir() string {
	if h := os.Getenv("NEXPATCH_AGENT_HOME"); h != "" {
		return filepath.Join(h, "program")
	}
	pf := os.Getenv("ProgramFiles")
	if pf == "" {
		pf = `C:\Program Files`
	}
	return filepath.Join(pf, "NexpatchOnline", "Agent")
}

func dataDir() string {
	if h := os.Getenv("NEXPATCH_AGENT_HOME"); h != "" {
		return filepath.Join(h, "data")
	}
	pd := os.Getenv("ProgramData")
	if pd == "" {
		pd = `C:\ProgramData`
	}
	return filepath.Join(pd, "NexpatchOnline", "Agent")
}

// The NexpatchOnline install script writes one log per app here; the agent reads the results.
func wrapperLogDir() string {
	if h := os.Getenv("NEXPATCH_AGENT_HOME"); h != "" {
		return filepath.Join(h, "wrapperlogs")
	}
	pd := os.Getenv("ProgramData")
	if pd == "" {
		pd = `C:\ProgramData`
	}
	return filepath.Join(pd, "NexpatchOnline", "Logs")
}

func exeName() string      { return "nexpatch-agent.exe" }
func configPath() string   { return filepath.Join(dataDir(), "config.json") }
func statePath() string    { return filepath.Join(dataDir(), "state.json") }
func logDir() string       { return filepath.Join(dataDir(), "logs") }
func queueDir() string     { return filepath.Join(dataDir(), "queue") }
func installedExe() string { return filepath.Join(programDir(), exeName()) }

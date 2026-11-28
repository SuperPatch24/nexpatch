//go:build windows

package main

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

var (
	procCreateMutex = kernel32.NewProc("CreateMutexW")
	agentMutex      uintptr
)

// singleInstance makes sure only one agent loop runs, however it was started.
func singleInstance() bool {
	name, _ := syscall.UTF16PtrFromString(`Global\NexpatchOnlineAgent`)
	h, _, err := procCreateMutex.Call(0, 0, uintptr(unsafe.Pointer(name)))
	if h == 0 {
		return true // can't tell; better to run than not
	}
	agentMutex = h
	return err != syscall.Errno(183) // ERROR_ALREADY_EXISTS
}

func run(name string, args ...string) (string, error) {
	cmd := exec.Command(name, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	out, err := cmd.CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := dst + ".new"
	out, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	for i := 0; i < 10; i++ { // the old agent may still be closing
		if err = os.Rename(tmp, dst); err == nil {
			return nil
		}
		time.Sleep(time.Second)
	}
	return err
}

func stopAgent() {
	_, _ = run("schtasks.exe", "/End", "/TN", TaskName)
	_, _ = run("taskkill.exe", "/F", "/IM", exeName(), "/FI", "PID ne "+strconv.Itoa(os.Getpid()))
	time.Sleep(2 * time.Second)
}

func cmdInstall() int {
	log := NewLogger(logDir(), "info", true)
	defer log.Close()
	exe, err := os.Executable()
	if err != nil {
		log.Error("can't find my own file", "err", err)
		return 1
	}
	var pkg Config
	if err := loadJSON(filepath.Join(filepath.Dir(exe), "config.json"), &pkg); err != nil {
		log.Error("config.json is missing next to the agent; install it from the NexpatchOnline Intune package", "err", err)
		return 1
	}
	if err := pkg.Validate(); err != nil {
		log.Error("config.json is not valid", "err", err)
		return 1
	}
	if err := os.MkdirAll(programDir(), 0o755); err != nil {
		log.Error("can't create the program folder; run as administrator or let Intune install it", "err", err)
		return 1
	}
	stopAgent()
	if !strings.EqualFold(filepath.Clean(exe), filepath.Clean(installedExe())) {
		if err := copyFile(exe, installedExe()); err != nil {
			log.Error("can't copy the agent to Program Files", "err", err)
			return 1
		}
	}
	for _, d := range []string{dataDir(), logDir(), queueDir()} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			log.Error("can't create the data folder", "folder", d, "err", err)
			return 1
		}
	}
	// Only SYSTEM and Administrators can read the token and key.
	if out, err := run("icacls.exe", dataDir(), "/inheritance:r", "/grant:r", "*S-1-5-18:(OI)(CI)F", "/grant:r", "*S-1-5-32-544:(OI)(CI)F", "/T", "/C", "/Q"); err != nil {
		log.Warn("couldn't restrict the data folder", "err", err, "output", out)
	}
	var current *Config
	var cur Config
	if loadJSON(configPath(), &cur) == nil {
		current = &cur
	}
	st := loadState()
	cfg, fresh := mergeConfig(pkg, current, st)
	if fresh {
		st.Token, st.Revoked, st.EnrolledAt = "", false, ""
		_ = saveJSON(statePath(), st)
	}
	if err := saveJSON(configPath(), cfg); err != nil {
		log.Error("can't write config.json", "err", err)
		return 1
	}
	if out, err := run("reg.exe", "add", `HKLM\SOFTWARE\NexpatchOnline\Agent`, "/v", "Version", "/t", "REG_SZ", "/d", AgentVersion, "/f", "/reg:64"); err != nil {
		log.Error("can't write the version to the registry", "err", err, "output", out)
		return 1
	}
	_, _ = run("reg.exe", "add", `HKLM\SOFTWARE\NexpatchOnline\Agent`, "/v", "InstallPath", "/t", "REG_SZ", "/d", programDir(), "/f", "/reg:64")
	xmlPath := filepath.Join(os.TempDir(), "nexpatch-agent-task.xml")
	if err := os.WriteFile(xmlPath, utf16File(TaskXML(installedExe())), 0o600); err != nil {
		log.Error("can't write the task definition", "err", err)
		return 1
	}
	out, err := run("schtasks.exe", "/Create", "/TN", TaskName, "/XML", xmlPath, "/F")
	_ = os.Remove(xmlPath)
	if err != nil {
		log.Error("can't create the scheduled task", "err", err, "output", out)
		return 1
	}
	if out, err := run("schtasks.exe", "/Run", "/TN", TaskName); err != nil {
		log.Warn("the task was created but didn't start; it will start at the next boot or within the hour", "output", out)
	}
	log.Info("agent installed", "version", AgentVersion, "folder", programDir(), "freshEnrollment", fresh)
	fmt.Println("NexpatchOnline agent " + AgentVersion + " installed.")
	return 0
}

func cmdUninstall() int {
	stopAgent()
	_, _ = run("schtasks.exe", "/Delete", "/TN", TaskName, "/F")
	_, _ = run("reg.exe", "delete", `HKLM\SOFTWARE\NexpatchOnline\Agent`, "/f", "/reg:64")
	_ = os.RemoveAll(dataDir())
	exe, _ := os.Executable()
	if strings.HasPrefix(strings.ToLower(filepath.Clean(exe)), strings.ToLower(filepath.Clean(programDir()))) {
		// A running program can't delete itself: let a short-lived helper do it.
		cmd := exec.Command("cmd.exe", "/C", "ping -n 4 127.0.0.1 >nul & rmdir /S /Q \""+programDir()+"\"")
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
		_ = cmd.Start()
	} else {
		_ = os.RemoveAll(programDir())
	}
	fmt.Println("NexpatchOnline agent removed.")
	return 0
}

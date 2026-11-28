//go:build windows

package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

var (
	kernel32       = syscall.NewLazyDLL("kernel32.dll")
	procTick64     = kernel32.NewProc("GetTickCount64")
	procDiskFreeEx = kernel32.NewProc("GetDiskFreeSpaceExW")
)

const uninstallPath = `SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`

// collectApps reads the same uninstall entries Windows' "Installed apps" page uses, for the machine and for every
// signed-in user.
func collectApps() []App {
	var apps []App
	read := func(root syscall.Handle, path, scope, arch string) {
		k, ok := regOpen(root, path)
		if !ok {
			return
		}
		defer k.Close()
		for _, sub := range k.Subkeys() {
			e, ok := regOpen(root, path+`\`+sub)
			if !ok {
				continue
			}
			name := e.String("DisplayName")
			sys, _ := e.Dword("SystemComponent")
			parent := e.String("ParentKeyName")
			rel := strings.ToLower(e.String("ReleaseType"))
			if name != "" && sys != 1 && parent == "" && rel != "update" && rel != "hotfix" && rel != "security update" {
				a := App{Name: name, Version: e.String("DisplayVersion"), Publisher: e.String("Publisher"), Scope: scope, Arch: arch, InstallDate: e.String("InstallDate")}
				if wi, _ := e.Dword("WindowsInstaller"); wi == 1 && guidRe.MatchString(strings.Trim(sub, "{}")) {
					a.ProductCode = strings.ToUpper(sub)
				}
				apps = append(apps, a)
			}
			e.Close()
		}
	}
	read(syscall.HKEY_LOCAL_MACHINE, uninstallPath, "machine", "x64")
	read(syscall.HKEY_LOCAL_MACHINE, `SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall`, "machine", "x86")
	if users, ok := regOpen(syscall.HKEY_USERS, ""); ok {
		for _, sid := range users.Subkeys() {
			if strings.HasPrefix(sid, "S-1-5-21-") && !strings.HasSuffix(sid, "_Classes") {
				read(syscall.HKEY_USERS, sid+`\Software\Microsoft\Windows\CurrentVersion\Uninstall`, "user", "x64")
			}
		}
		users.Close()
	}
	return CleanApps(apps)
}

// The Intune device ID, from the MDM enrollment.
func intuneDeviceID() string {
	k, ok := regOpen(syscall.HKEY_LOCAL_MACHINE, `SOFTWARE\Microsoft\Enrollments`)
	if !ok {
		return ""
	}
	defer k.Close()
	for _, sub := range k.Subkeys() {
		if d, ok := regOpen(syscall.HKEY_LOCAL_MACHINE, `SOFTWARE\Microsoft\Enrollments\`+sub+`\DMClient\MS DM Server`); ok {
			id := strings.Trim(d.String("EntDMID"), "{}")
			d.Close()
			if guidRe.MatchString(id) {
				return strings.ToLower(id)
			}
		}
	}
	return ""
}

func collectDevice() Device {
	d := Device{IntuneDeviceID: intuneDeviceID()}
	d.Name, _ = os.Hostname()
	if k, ok := regOpen(syscall.HKEY_LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows NT\CurrentVersion`); ok {
		d.OS.Build = k.String("CurrentBuild")
		d.OS.Product = WindowsProductName(k.String("ProductName"), d.OS.Build)
		d.OS.DisplayVersion = k.String("DisplayVersion")
		d.OS.Edition = k.String("EditionID")
		d.OS.UBR, _ = k.Dword("UBR")
		k.Close()
	}
	d.OS.Arch = runtime.GOARCH
	if a := os.Getenv("PROCESSOR_ARCHITECTURE"); a != "" {
		d.OS.Arch = strings.ToLower(a)
	}
	if k, ok := regOpen(syscall.HKEY_LOCAL_MACHINE, `HARDWARE\DESCRIPTION\System\BIOS`); ok {
		d.Manufacturer = k.String("SystemManufacturer")
		d.Model = k.String("SystemProductName")
		k.Close()
	}
	if r, _, _ := procTick64.Call(); r != 0 {
		d.UptimeHours = int(r / 3600000)
	}
	d.RebootPending = regExists(syscall.HKEY_LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending`) ||
		regExists(syscall.HKEY_LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired`)
	drive := os.Getenv("SystemDrive")
	if drive == "" {
		drive = "C:"
	}
	if p, err := syscall.UTF16PtrFromString(drive + `\`); err == nil {
		var free, total, totalFree uint64
		if r, _, _ := procDiskFreeEx.Call(uintptr(unsafe.Pointer(p)), uintptr(unsafe.Pointer(&free)), uintptr(unsafe.Pointer(&total)), uintptr(unsafe.Pointer(&totalFree))); r != 0 {
			d.DiskFreeGB, d.DiskTotalGB = int(free>>30), int(total>>30)
		}
	}
	return d
}

var appInstallerDir = regexp.MustCompile(`(?i)Microsoft\.DesktopAppInstaller_([0-9.]+)_(x64|arm64|x86)__8wekyb3d8bbwe$`)

// findWinget returns the newest winget.exe installed for all users, like the install script does.
func findWinget() (string, string) {
	pf := os.Getenv("ProgramW6432")
	if pf == "" {
		pf = os.Getenv("ProgramFiles")
	}
	matches, _ := filepath.Glob(filepath.Join(pf, "WindowsApps", "Microsoft.DesktopAppInstaller_*__8wekyb3d8bbwe", "winget.exe"))
	type cand struct{ path, ver string }
	var cs []cand
	for _, m := range matches {
		if g := appInstallerDir.FindStringSubmatch(filepath.Dir(m)); g != nil {
			cs = append(cs, cand{m, g[1]})
		}
	}
	if len(cs) == 0 {
		return "", ""
	}
	sort.Slice(cs, func(i, j int) bool { return compareVersions(cs[i].ver, cs[j].ver) > 0 })
	return cs[0].path, cs[0].ver
}

func collectHealth() Health {
	var h Health
	path, aiv := findWinget()
	h.Winget.AppInstallerVersion = aiv
	if path == "" {
		h.Winget.Error = "winget isn't installed for all users (App Installer is missing)."
	} else {
		h.Winget.Found, h.Winget.Path = true, path
		ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		cmd := exec.CommandContext(ctx, path, "--version")
		cmd.Dir = filepath.Dir(path)
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
		out, err := cmd.Output()
		cancel()
		h.Winget.Version = strings.TrimSpace(string(out))
		var ee *exec.ExitError
		switch {
		case err == nil:
			h.Winget.OK = true
		case errors.As(err, &ee):
			h.Winget.ExitCode = signedExit(ee.ExitCode())
			h.Winget.Error = WingetStartProblem(h.Winget.ExitCode)
		case ctx.Err() != nil:
			h.Winget.Error = "winget didn't answer within 90 seconds."
		default:
			h.Winget.Error = truncate(err.Error(), 200)
		}
	}
	if k, ok := regOpen(syscall.HKEY_LOCAL_MACHINE, `SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\X64`); ok {
		inst, _ := k.Dword("Installed")
		h.VCRuntime.Installed = inst == 1
		h.VCRuntime.Version = k.String("Version")
		k.Close()
	}
	sys := filepath.Join(os.Getenv("SystemRoot"), "System32")
	_, e1 := os.Stat(filepath.Join(sys, "vcruntime140.dll"))
	_, e2 := os.Stat(filepath.Join(sys, "msvcp140.dll"))
	h.VCRuntime.DLLs = e1 == nil && e2 == nil
	return h
}

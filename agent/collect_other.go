//go:build !windows

package main

import "os"

// Non-Windows builds exist only so the shared logic can be tested on any machine.
func collectApps() []App { return nil }
func collectDevice() Device {
	n, _ := os.Hostname()
	return Device{Name: n, IntuneDeviceID: intuneDeviceID(), OS: OSInfo{Product: "test"}}
}
func collectHealth() Health  { return Health{} }
func intuneDeviceID() string { return os.Getenv("NEXPATCH_TEST_INTUNE_ID") }

package main

import (
	"fmt"
	"strconv"
	"strings"
)

// WingetStartProblem explains why winget itself failed to run.
func WingetStartProblem(code int) string {
	switch code {
	case -1073741701:
		return "winget can't start (0xC000007B): the Visual C++ runtime is missing or damaged."
	case -1073741515:
		return "winget can't start (0xC0000135): a file it needs is missing. Repair App Installer or install the Visual C++ runtime."
	case -1073741790:
		return "winget was denied access (0xC0000022)."
	}
	return fmt.Sprintf("winget ended with exit code %d.", code)
}

// compareVersions compares dotted numbers (1.24.25200.0) part by part.
func compareVersions(a, b string) int {
	pa, pb := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < len(pa) || i < len(pb); i++ {
		var x, y int
		if i < len(pa) {
			x, _ = strconv.Atoi(pa[i])
		}
		if i < len(pb) {
			y, _ = strconv.Atoi(pb[i])
		}
		if x != y {
			if x > y {
				return 1
			}
			return -1
		}
	}
	return 0
}

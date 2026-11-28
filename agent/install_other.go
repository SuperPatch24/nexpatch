//go:build !windows

package main

import "fmt"

func singleInstance() bool { return true }
func cmdInstall() int      { fmt.Println("install works on Windows only"); return 1 }
func cmdUninstall() int    { fmt.Println("uninstall works on Windows only"); return 1 }

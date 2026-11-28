// NexpatchOnline device agent.
//
// One small program that runs as SYSTEM on each Windows device. It reports what is installed, whether winget can run,
// and the result of every NexpatchOnline install, so the platform can show real patch status per device.
//
// Commands (run from an administrator prompt):
//
//	nexpatch-agent install     install from the Intune package (reads config.json next to the exe)
//	nexpatch-agent uninstall   remove the agent, its scheduled task and its data
//	nexpatch-agent run         the long-running loop (started by the scheduled task)
//	nexpatch-agent once        collect and send one full report now, and print the result
//	nexpatch-agent status      print the agent's health
//	nexpatch-agent diag        write a support bundle (secrets removed) and print its path
//	nexpatch-agent version     print the version
package main

import (
	"fmt"
	"os"
	"strings"
)

// AgentVersion is reported to NexpatchOnline and written to the registry for Intune's detection rule.
const AgentVersion = "1.0.0"

func main() {
	cmd := "help"
	if len(os.Args) > 1 {
		cmd = strings.ToLower(strings.TrimLeft(os.Args[1], "-/"))
	}
	switch cmd {
	case "install":
		os.Exit(cmdInstall())
	case "uninstall":
		os.Exit(cmdUninstall())
	case "run":
		os.Exit(cmdRun())
	case "once":
		os.Exit(cmdOnce())
	case "status":
		os.Exit(cmdStatus())
	case "diag":
		os.Exit(cmdDiag())
	case "version", "v":
		fmt.Println(AgentVersion)
	default:
		fmt.Println("NexpatchOnline agent " + AgentVersion)
		fmt.Println("Usage: nexpatch-agent install | uninstall | run | once | status | diag | version")
		if cmd != "help" && cmd != "h" && cmd != "?" {
			os.Exit(2)
		}
	}
}

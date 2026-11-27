# NexpatchOnline device agent

A small Windows program (`nexpatch-agent.exe`, written in Go, no runtime needed) that reports to NexpatchOnline:
installed apps and versions, Windows build, disk space, pending restart, winget health (including the Visual C++
runtime problem behind exit code -1073741701), and the result of every NexpatchOnline install on the device.

## Deploy it (company admins)
1. Open **Device agent** in NexpatchOnline.
2. Pick a pilot group and press **Publish to Intune**. NexpatchOnline creates the Win32 app "NexpatchOnline Agent",
   uploads it, and assigns it as required. Intune installs it within the usual Intune check-in time.
3. Devices appear on the page after their first report (usually within an hour of installing).

Intune runs `nexpatch-agent.exe install` itself, so no PowerShell is involved. If your App Control base policy trusts
Intune as a managed installer (the NexpatchOnline default), the agent is allowed automatically.

**Test on one PC first (optional):** press **Test on one PC**. It downloads a `config.json` valid for 7 days. Download
the exe from `https://nexpatchonline.com/agent/nexpatch-agent.exe`, put both in one folder and run
`nexpatch-agent.exe install` from an administrator Command Prompt. The PC must be in your Intune device list.

## On a device
| Command (administrator prompt) | What it does |
| --- | --- |
| `"C:\Program Files\NexpatchOnline\Agent\nexpatch-agent.exe" status` | Health, last report, recent errors |
| `... once` | Collect and send a full report now |
| `... diag` | Support bundle (tokens and keys removed) in `C:\ProgramData\NexpatchOnline\Agent` |
| `... uninstall` | Remove the agent, its task and data |

Logs: `C:\ProgramData\NexpatchOnline\Agent\logs\agent.log` (one JSON line per event, 5 files of 5 MB kept).

## How it is secured
- Enrollment uses a key inside the Intune package (valid 1 year; republishing makes a new one). A device can only
  enroll if its Intune device ID is in the organization's own Intune device list, so a copied key can't register other PCs.
- Each device then gets its own token (stored hashed on the server). Admins can revoke one device on the Device agent page.
- The data folder is readable only by SYSTEM and Administrators. The key is deleted from disk after enrollment.
- It sends app names, versions and publishers, Windows and hardware details, and install results. It never reads
  files, documents, browsing or user content. Reports are at most 1 MB and rate-limited.

## Building it
`agent/build.sh` builds the exe reproducibly (Go 1.24.7) and writes its SHA-256 to `api/src/lib/agentrelease.js`.
The **Agent** GitHub workflow rebuilds it and fails if the shipped exe doesn't match the source. After changing the
source, run `agent/build.sh` and commit `api/assets/agent/nexpatch-agent.exe`, `public/agent/nexpatch-agent.exe`
(copy of the same file) and `agentrelease.js`.

Next steps worth doing: sign the exe with a code-signing certificate (Azure Trusted Signing is the low-cost option),
and add automatic updates.

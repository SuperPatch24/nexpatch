# App Control agent (live blocks)

The NexpatchOnline agent runs on each Windows device, watches the App Control log and sends blocked or audited apps to the platform within seconds. Admins then decide what to do on App Control > Activity.

## How it works
- Installed once with an Intune platform script (App Control > Activity > choose "NexpatchOnline agent" > Create device key and installer).
- Runs as SYSTEM from a scheduled task named "NexpatchOnline App Control agent" that starts at boot and restarts itself if it stops.
- Checks the Microsoft-Windows-CodeIntegrity/Operational log every 15 seconds for events 3076 (audited), 3077 (blocked) and 3089 (signer details).
- Sends a heartbeat every 5 minutes so the platform can show how many devices are online.
- If the platform can't be reached it keeps the position in the log and retries with longer waits (up to 5 minutes). Nothing is lost.
- Writes a small log to C:\ProgramData\NexpatchOnline\Collector\agent.log (rotates at 1 MB).
- Security model: the installer carries a short-lived enrollment key (30 days). On first run the device reads its Intune device ID, enrolls, and receives its own token. The token is stored encrypted for that machine (DPAPI) and the enrollment key is deleted from the device. After that only the device token works.
- The platform accepts enrollment only for devices that exist in your Intune device list (the inventory sync must have run), limits enrollments and events per hour, and takes the device name from Intune, not from the device.
- Admins can revoke or restore any single device on App Control > Activity > Devices running the agent. A leaked enrollment key can't read data and can't be used after it expires. Create a new installer to issue a new key.
- Sends only: device name, time, allowed/blocked, file path, process, policy name, hashes, publisher, user name. No file contents.

## What admins can do on the platform
Allow the publisher, allow the file (both feed the supplemental policy), mark as blocked, ignore, or undo. Viewers can see activity but not act. The page checks for new events every 10 seconds and shows a message when new ones arrive.

## Upgrading from the 15-minute collector
Download a new installer and run it again (or redeploy the platform script). It removes the old task and installs the agent. The old 15-minute collector's shared key no longer works, so every device needs the new installer.

## Check a device
- Task Scheduler: "NexpatchOnline App Control agent" is Running.
- `Get-Content C:\ProgramData\NexpatchOnline\Collector\agent.log -Tail 20`
- Test: with an audit-mode policy, start an unlisted app; the event shows on the platform within about a minute.

Note: App Control must be deployed (audit or enforce) for devices to log events at all.

## Before real customers
- Test on one device: confirm it enrolls (agent.log says 'Enrolled with NexpatchOnline') and that the device appears in the devices list.
- The agent reads the Intune device ID from HKLM:\SOFTWARE\Microsoft\Enrollments (EntDMID). If your devices don't have it, tell us and we'll switch to another source.
- Sign Agent.ps1 with your code-signing certificate, or allow it in your App Control policy, if you enforce script rules.

// Scripts for the NexpatchOnline App Control agent. The installer runs once as SYSTEM (Intune platform script) and sets up a
// boot-time scheduled task; the agent checks for new App Control events every 15 seconds and sends them to NexpatchOnline.
export const COLLECTOR = String.raw`# NexpatchOnline App Control agent 2.1 - watches App Control events on this device and sends them to NexpatchOnline within seconds.
# Security: the device enrolls once with a short-lived key, receives its own token (stored encrypted for this machine), and deletes the key.
# Runs as SYSTEM from a scheduled task that starts at boot. Safe to run twice: a second copy exits.
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$AgentVersion = '2.1'
$Dir = Join-Path $env:ProgramData 'NexpatchOnline\Collector'
$Config = Get-Content -Path (Join-Path $Dir 'config.json') -Raw | ConvertFrom-Json
$StateFile = Join-Path $Dir 'state.json'
$ConfigFile = Join-Path $Dir 'config.json'
$IdentityFile = Join-Path $Dir 'identity.json'
$LogFile = Join-Path $Dir 'agent.log'
$Mutex = New-Object System.Threading.Mutex($false, 'Global\NexpatchOnlineAppControlAgent')
$Owned = $false
try { $Owned = $Mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $Owned = $true }
if (-not $Owned) { return }

function Write-Log([string]$Message) {
    try {
        if ((Test-Path $LogFile) -and ((Get-Item $LogFile).Length -gt 1MB)) { Move-Item -Path $LogFile -Destination ($LogFile + '.old') -Force }
        Add-Content -Path $LogFile -Value ('{0} {1}' -f (Get-Date).ToUniversalTime().ToString('o'), $Message)
    } catch { }
}

Add-Type -Namespace NexpatchOnlineCollector -Name Kernel -MemberDefinition '[DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern uint QueryDosDevice(string name, System.Text.StringBuilder target, int max);'
function Get-DriveMap {
    $map = @{}
    foreach ($d in [IO.DriveInfo]::GetDrives()) {
        $letter = $d.Name.Substring(0, 2)
        $sb = New-Object System.Text.StringBuilder 260
        if ([NexpatchOnlineCollector.Kernel]::QueryDosDevice($letter, $sb, 260)) { $map[$sb.ToString()] = $letter }
    }
    return $map
}
function ConvertTo-DosPath([string]$Path) {
    foreach ($k in $script:Drives.Keys) { if ($Path.StartsWith($k + '\', [StringComparison]::OrdinalIgnoreCase)) { return $script:Drives[$k] + $Path.Substring($k.Length) } }
    return $Path
}
function Get-EventFields($Event) {
    $x = [xml]$Event.ToXml()
    $f = @{}
    foreach ($n in $x.Event.EventData.Data) { $f[$n.Name] = [string]$n.'#text' }
    $f['_activity'] = [string]$x.Event.System.Correlation.ActivityID
    return $f
}
function Get-AccountName($Sid) {
    if (-not $Sid) { return '' }
    try { return (New-Object System.Security.Principal.SecurityIdentifier $Sid).Translate([System.Security.Principal.NTAccount]).Value } catch { return [string]$Sid }
}

function Get-NewEvents {
    $Last = [int64]0
    if (Test-Path $StateFile) { $Last = [int64]((Get-Content -Path $StateFile -Raw | ConvertFrom-Json).lastRecordId) }
    $Filter = "*[System[(EventID=3076 or EventID=3077 or EventID=3089) and EventRecordID > $Last]]"
    if ($Last -eq 0) { $Filter = "*[System[(EventID=3076 or EventID=3077 or EventID=3089) and TimeCreated[timediff(@SystemTime) <= 604800000]]]" }
    $Events = @(Get-WinEvent -LogName 'Microsoft-Windows-CodeIntegrity/Operational' -FilterXPath $Filter -ErrorAction SilentlyContinue | Sort-Object RecordId)
    if ($Events.Count -eq 0) { return $null }
    $script:Drives = Get-DriveMap
    # Signer details (3089) share a correlation ID with the block or audit event they describe
    $Signers = @{}
    foreach ($e in ($Events | Where-Object { $_.Id -eq 3089 })) {
        $f = Get-EventFields $e
        if ($f['_activity'] -and -not $Signers.ContainsKey($f['_activity'])) { $Signers[$f['_activity']] = $f }
    }
    $Out = @(foreach ($e in ($Events | Where-Object { $_.Id -ne 3089 })) {
        $f = Get-EventFields $e
        $s = $Signers[$f['_activity']]
        [ordered]@{
            time       = $e.TimeCreated.ToUniversalTime().ToString('o')
            action     = $(if ($e.Id -eq 3077) { 'blocked' } else { 'audited' })
            path       = ConvertTo-DosPath $f['File Name']
            process    = ConvertTo-DosPath $f['Process Name']
            policy     = $f['PolicyName']
            sha1       = $f['SHA1 Hash']
            sha256     = $f['SHA256 Hash']
            sha256Flat = $f['SHA256 Flat Hash']
            publisher  = $(if ($s) { $s['PublisherName'] } else { '' })
            issuer     = $(if ($s) { $s['IssuerName'] } else { '' })
            issuerTbs  = $(if ($s) { $s['IssuerTBSHash'] } else { '' })
            user       = Get-AccountName $e.UserId
        }
    })
    return @{ Out = $Out; LastId = ($Events | Select-Object -Last 1).RecordId }
}

Add-Type -AssemblyName System.Security
function Get-IntuneDeviceId {
    foreach ($k in @(Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\Enrollments' -ErrorAction SilentlyContinue)) {
        $p = Get-ItemProperty -Path $k.PSPath -ErrorAction SilentlyContinue
        if ($p.ProviderID -eq 'MS DM Server' -and $p.EntDMID) { return [string]$p.EntDMID }
    }
    $c = Get-ChildItem 'Cert:\LocalMachine\My' -ErrorAction SilentlyContinue | Where-Object { $_.Issuer -match 'Intune MDM' } | Select-Object -First 1
    if ($c -and $c.Subject -match '^CN=([0-9a-fA-F-]{36})$') { return $Matches[1] }
    return ''
}
function Get-Identity {
    if (-not (Test-Path $IdentityFile)) { return $null }
    $i = Get-Content -Path $IdentityFile -Raw | ConvertFrom-Json
    $plain = [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($i.token), $null, 'LocalMachine'))
    return @{ DeviceId = [string]$i.deviceId; Token = $plain }
}
function Remove-EnrollmentKey {
    if ($Config.key) {
        @{ tenantId = $Config.tenantId; base = $Config.base } | ConvertTo-Json | Set-Content -Path $ConfigFile -Encoding UTF8
        $Config.key = ''
    }
}
function Register-Device {
    if (-not $Config.key) { throw 'This device is not enrolled and has no enrollment key. Run the installer from the App Control page again.' }
    $id = Get-IntuneDeviceId
    if (-not $id) { throw 'Could not find the Intune device ID. Is this device enrolled in Intune?' }
    $h = @{ 'x-nexpatch-tenant' = $Config.tenantId; 'x-nexpatch-key' = $Config.key }
    $body = @{ deviceId = $id; name = $env:COMPUTERNAME } | ConvertTo-Json -Compress
    $r = Invoke-RestMethod -Method POST -Uri ($Config.base + 'enroll') -Headers $h -Body ([Text.Encoding]::UTF8.GetBytes($body)) -ContentType 'application/json' -TimeoutSec 60
    $prot = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes([string]$r.token), $null, 'LocalMachine')
    @{ deviceId = [string]$r.deviceId; token = [Convert]::ToBase64String($prot) } | ConvertTo-Json | Set-Content -Path $IdentityFile -Encoding UTF8
    Remove-EnrollmentKey
    Write-Log 'Enrolled with NexpatchOnline'
}
function Send-Batch($Chunk) {
    $h = @{ 'x-nexpatch-tenant' = $Config.tenantId; 'x-nexpatch-device' = $script:Identity.DeviceId; 'x-nexpatch-token' = $script:Identity.Token }
    $body = @{ agent = $AgentVersion; events = @($Chunk) } | ConvertTo-Json -Depth 4 -Compress
    Invoke-RestMethod -Method POST -Uri ($Config.base + 'ingest') -Headers $h -Body ([Text.Encoding]::UTF8.GetBytes($body)) -ContentType 'application/json' -TimeoutSec 60 | Out-Null
}

Write-Log "Agent $AgentVersion started"
$Failures = 0
$LastSend = [datetime]::MinValue
$script:Identity = $null
while ($true) {
    $Wait = 15
    try {
        if (-not $script:Identity) { $script:Identity = Get-Identity }
        if (-not $script:Identity) { Register-Device; $script:Identity = Get-Identity }
        Remove-EnrollmentKey
        $r = Get-NewEvents
        if ($r) {
            for ($i = 0; $i -lt $r.Out.Count; $i += 500) { Send-Batch ($r.Out[$i..([Math]::Min($i + 499, $r.Out.Count - 1))]) }
            @{ lastRecordId = $r.LastId } | ConvertTo-Json | Set-Content -Path $StateFile -Encoding UTF8
            $LastSend = Get-Date
            Write-Log ('Sent ' + $r.Out.Count + ' event(s)')
        } elseif (((Get-Date) - $LastSend).TotalMinutes -ge 5) {
            Send-Batch @()   # heartbeat: lets the platform show this device as online
            $LastSend = Get-Date
        }
        $Failures = 0
    } catch {
        $Failures++
        $Wait = [Math]::Min(300, 15 * [Math]::Pow(2, [Math]::Min($Failures, 5)))
        $Code = 0
        try { $Code = [int]$_.Exception.Response.StatusCode } catch { }
        if ($Code -eq 401 -or $Code -eq 403) { $Wait = 900 } elseif ($Code -eq 429) { $Wait = 600 }
        Write-Log ('Send failed (' + $Failures + '): ' + $_.Exception.Message)
    }
    Start-Sleep -Seconds $Wait
}
`;

export const INSTALLER = String.raw`# NexpatchOnline App Control agent - installer
# Deploy as an Intune platform script: run as SYSTEM (logged on credentials: No), 64-bit PowerShell: Yes.
$ErrorActionPreference = 'Stop'
$Dir = Join-Path $env:ProgramData 'NexpatchOnline\Collector'
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
# Only SYSTEM and Administrators can read the folder (it holds the device key)
& icacls.exe $Dir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null

@{ tenantId = '__TENANT__'; key = '__KEY__'; base = '__ENDPOINT__' } | ConvertTo-Json | Set-Content -Path (Join-Path $Dir 'config.json') -Encoding UTF8

$Collector = @'
__COLLECTOR__
'@
$TaskName = 'NexpatchOnline App Control agent'
# Replace the 15-minute collector from earlier versions, and stop a running agent before updating its script
Unregister-ScheduledTask -TaskName 'NexpatchOnline App Control collector' -Confirm:$false -ErrorAction SilentlyContinue
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue; Start-Sleep -Seconds 3 }
Remove-Item -Path (Join-Path $Dir 'Collect.ps1') -Force -ErrorAction SilentlyContinue
Set-Content -Path (Join-Path $Dir 'Agent.ps1') -Value $Collector -Encoding UTF8

$Action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $Dir 'Agent.ps1') + '"')
$Trigger = New-ScheduledTaskTrigger -AtStartup
$Principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Output 'NexpatchOnline App Control agent installed and running.'
`;

export const UNINSTALLER = String.raw`# NexpatchOnline App Control agent - uninstaller (run as SYSTEM)
foreach ($n in 'NexpatchOnline App Control agent', 'NexpatchOnline App Control collector') { Stop-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName $n -Confirm:$false -ErrorAction SilentlyContinue }
Remove-Item -Path (Join-Path $env:ProgramData 'NexpatchOnline\Collector') -Recurse -Force -ErrorAction SilentlyContinue
Write-Output 'NexpatchOnline App Control agent removed.'
`;

export function installerFor(tenantId, key, endpoint) {
  return INSTALLER.replace('__TENANT__', () => tenantId).replace('__KEY__', () => key).replace('__ENDPOINT__', () => endpoint).replace('__COLLECTOR__', () => COLLECTOR.trimEnd());
}

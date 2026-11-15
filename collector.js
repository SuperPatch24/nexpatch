// Scripts for the NexpatchOnline App Control collector. The installer runs once as SYSTEM (Intune platform script);
// the collector runs every 15 minutes and sends new App Control events to NexpatchOnline.
export const COLLECTOR = String.raw`# NexpatchOnline App Control collector - reads App Control events and sends them to NexpatchOnline
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Dir = Join-Path $env:ProgramData 'NexpatchOnline\Collector'
$Config = Get-Content -Path (Join-Path $Dir 'config.json') -Raw | ConvertFrom-Json
$StateFile = Join-Path $Dir 'state.json'
$Last = [int64]0
if (Test-Path $StateFile) { $Last = [int64]((Get-Content -Path $StateFile -Raw | ConvertFrom-Json).lastRecordId) }

$Filter = "*[System[(EventID=3076 or EventID=3077 or EventID=3089) and EventRecordID > $Last]]"
if ($Last -eq 0) { $Filter = "*[System[(EventID=3076 or EventID=3077 or EventID=3089) and TimeCreated[timediff(@SystemTime) <= 604800000]]]" }
$Events = @(Get-WinEvent -LogName 'Microsoft-Windows-CodeIntegrity/Operational' -FilterXPath $Filter -ErrorAction SilentlyContinue | Sort-Object RecordId)
if ($Events.Count -eq 0) { return }

# Map \Device\HarddiskVolumeN to drive letters
Add-Type -Namespace NexpatchOnlineCollector -Name Kernel -MemberDefinition '[DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern uint QueryDosDevice(string name, System.Text.StringBuilder target, int max);'
$Drives = @{}
foreach ($d in [IO.DriveInfo]::GetDrives()) {
    $letter = $d.Name.Substring(0, 2)
    $sb = New-Object System.Text.StringBuilder 260
    if ([NexpatchOnlineCollector.Kernel]::QueryDosDevice($letter, $sb, 260)) { $Drives[$sb.ToString()] = $letter }
}
function ConvertTo-DosPath([string]$Path) {
    foreach ($k in $Drives.Keys) { if ($Path.StartsWith($k + '\', [StringComparison]::OrdinalIgnoreCase)) { return $Drives[$k] + $Path.Substring($k.Length) } }
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

$Headers = @{ 'x-nexpatch-tenant' = $Config.tenantId; 'x-nexpatch-key' = $Config.key }
for ($i = 0; $i -lt $Out.Count; $i += 500) {
    $chunk = $Out[$i..([Math]::Min($i + 499, $Out.Count - 1))]
    $body = @{ device = $env:COMPUTERNAME; events = @($chunk) } | ConvertTo-Json -Depth 4 -Compress
    Invoke-RestMethod -Method POST -Uri $Config.endpoint -Headers $Headers -Body ([Text.Encoding]::UTF8.GetBytes($body)) -ContentType 'application/json' -TimeoutSec 60 | Out-Null
}
@{ lastRecordId = ($Events | Select-Object -Last 1).RecordId } | ConvertTo-Json | Set-Content -Path $StateFile -Encoding UTF8
`;

export const INSTALLER = String.raw`# NexpatchOnline App Control collector - installer
# Deploy as an Intune platform script: run as SYSTEM (logged on credentials: No), 64-bit PowerShell: Yes.
$ErrorActionPreference = 'Stop'
$Dir = Join-Path $env:ProgramData 'NexpatchOnline\Collector'
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
# Only SYSTEM and Administrators can read the folder (it holds the device key)
& icacls.exe $Dir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null

@{ tenantId = '__TENANT__'; key = '__KEY__'; endpoint = '__ENDPOINT__' } | ConvertTo-Json | Set-Content -Path (Join-Path $Dir 'config.json') -Encoding UTF8

$Collector = @'
__COLLECTOR__
'@
Set-Content -Path (Join-Path $Dir 'Collect.ps1') -Value $Collector -Encoding UTF8

$Action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $Dir 'Collect.ps1') + '"')
$Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 15) -RandomDelay (New-TimeSpan -Minutes 5)
$Principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'NexpatchOnline App Control collector' -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings -Force | Out-Null
Start-ScheduledTask -TaskName 'NexpatchOnline App Control collector'
Write-Output 'NexpatchOnline App Control collector installed.'
`;

export const UNINSTALLER = String.raw`# NexpatchOnline App Control collector - uninstaller (run as SYSTEM)
Unregister-ScheduledTask -TaskName 'NexpatchOnline App Control collector' -Confirm:$false -ErrorAction SilentlyContinue
Remove-Item -Path (Join-Path $env:ProgramData 'NexpatchOnline\Collector') -Recurse -Force -ErrorAction SilentlyContinue
Write-Output 'NexpatchOnline App Control collector removed.'
`;

export function installerFor(tenantId, key, endpoint) {
  return INSTALLER.replace('__TENANT__', tenantId).replace('__KEY__', key).replace('__ENDPOINT__', endpoint).replace('__COLLECTOR__', COLLECTOR.trimEnd());
}

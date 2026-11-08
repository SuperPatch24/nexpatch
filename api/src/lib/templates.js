// Scripts that run on each device. Kept identical to the PowerShell publisher.
export const WRAPPER = String.raw`param([switch]$Uninstall)
$Id = '__ID__'
$AppName = '__NAME__'
$Procs = @(__PROCS__)
$ConflictMode = '__CONFLICT__'
$ConflictMinutes = __MINUTES__
$PreScript = '__PRE64__'
$PostScript = '__POST64__'

$LogDir = Join-Path $env:ProgramData 'NexpatchOnline\Logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
Start-Transcript -Path (Join-Path $LogDir ($Id + '.log')) -Append | Out-Null

function Get-Running { foreach ($p in $Procs) { Get-Process -Name $p -ErrorAction SilentlyContinue } }
function Stop-Running { Get-Running | Stop-Process -Force -ErrorAction SilentlyContinue }
function Send-UserMessage([string]$Text) {
    $msg = Join-Path $env:windir 'System32\msg.exe'
    if (Test-Path $msg) { & $msg '*' '/TIME:300' $Text 2>$null }
}
function Invoke-Embedded([string]$Base64, [string]$Label) {
    if (-not $Base64) { return }
    Write-Output "Running the $Label script"
    $code = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Base64))
    & ([scriptblock]::Create($code))
}

$exit = 0
try {
    $Winget = Get-ChildItem -Path (Join-Path $env:ProgramFiles 'WindowsApps\Microsoft.DesktopAppInstaller_*_x64__8wekyb3d8bbwe\winget.exe') -ErrorAction SilentlyContinue | Sort-Object LastWriteTime | Select-Object -Last 1
    if (-not $Winget) { throw 'winget was not found on this device' }

    if (Get-Running) {
        switch ($ConflictMode) {
            'Defer'  { Write-Output "$AppName is running. Asking Intune to retry later."; Stop-Transcript | Out-Null; exit 1618 }
            'Notify' { Send-UserMessage "$AppName will close in $ConflictMinutes minutes to install an update. Please save your work."
                       Start-Sleep -Seconds ($ConflictMinutes * 60); Stop-Running }
            'Wait'   { Send-UserMessage "Please close $AppName so it can be updated. It will close automatically in $ConflictMinutes minutes."
                       $end = (Get-Date).AddMinutes($ConflictMinutes)
                       while ((Get-Running) -and ((Get-Date) -lt $end)) { Start-Sleep -Seconds 30 }
                       Stop-Running }
            default  { Stop-Running }
        }
    }

    $common = @('--id', $Id, '--exact', '--silent', '--scope', 'machine', '--accept-source-agreements', '--disable-interactivity')
    if ($Uninstall) {
        & $Winget.FullName uninstall @common
        $exit = $LASTEXITCODE
        if ($exit -eq -1978335212) { $exit = 0 }   # not installed
    } else {
        Invoke-Embedded $PreScript 'pre-install'
        & $Winget.FullName __ACTION__ @common --accept-package-agreements
        $exit = $LASTEXITCODE
        if ($exit -eq -1978335189 -or $exit -eq -1978335135) { $exit = 0 }   # no newer version / already installed
        if ($exit -eq 0) { Invoke-Embedded $PostScript 'post-install' }
    }
} catch {
    Write-Output "Error: $_"
    $exit = 1
}
Stop-Transcript | Out-Null
exit $exit`;

export const DETECT = String.raw`$Keys = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
$Min = '__VER__'
$App = Get-ItemProperty -Path $Keys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like '__NAME__*' } | Select-Object -First 1
if ($App) {
    $a = ($App.DisplayVersion -replace '[^\d\.]', '').Trim('.'); $b = ($Min -replace '[^\d\.]', '').Trim('.')
    try { if ([version]$a -ge [version]$b) { Write-Output 'Detected' } } catch { if ($App.DisplayVersion -eq $Min) { Write-Output 'Detected' } }
}
exit 0`;

export const REQUIREMENT = String.raw`$Keys = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
if (Get-ItemProperty -Path $Keys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like '__NAME__*' }) { 'Installed' } else { 'NotInstalled' }`;


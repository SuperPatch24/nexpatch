// Scripts that run on each device. Kept identical to the PowerShell publisher.
export const WRAPPER = String.raw`param([switch]$Uninstall)
# Intune can start install commands in 32-bit PowerShell; restart in 64-bit so paths and winget resolve correctly
if ($env:PROCESSOR_ARCHITEW6432 -eq 'AMD64') {
    $ps64 = Join-Path $env:windir 'sysnative\WindowsPowerShell\v1.0\powershell.exe'
    if (Test-Path $ps64) {
        $argList = @('-ExecutionPolicy', 'Bypass', '-NoProfile', '-File', $PSCommandPath)
        if ($Uninstall) { $argList += '-Uninstall' }
        & $ps64 @argList
        exit $LASTEXITCODE
    }
}
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

$ProgramFiles64 = if ($env:ProgramW6432) { $env:ProgramW6432 } else { $env:ProgramFiles }
function Find-Winget {
    Get-ChildItem -Path (Join-Path $ProgramFiles64 'WindowsApps\Microsoft.DesktopAppInstaller_*__8wekyb3d8bbwe\winget.exe') -ErrorAction SilentlyContinue | Sort-Object LastWriteTime | Select-Object -Last 1
}
# Installs App Installer (winget) for all users when it's missing, using Microsoft's own sources.
function Install-AppInstaller {
    Write-Output 'winget is missing. Installing App Installer for all users...'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $ProgressPreference = 'SilentlyContinue'
    # Method 1: Microsoft.WinGet.Client module (Repair-WinGetPackageManager)
    try {
        if (-not (Get-PackageProvider -ListAvailable -Name NuGet -ErrorAction SilentlyContinue)) { Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Force -Scope AllUsers | Out-Null }
        if (-not (Get-Module -ListAvailable -Name Microsoft.WinGet.Client)) { Install-Module -Name Microsoft.WinGet.Client -Repository PSGallery -Scope AllUsers -Force -AllowClobber | Out-Null }
        Import-Module Microsoft.WinGet.Client -Force
        Repair-WinGetPackageManager -AllUsers -Force -Latest | Out-Null
        if (Find-Winget) { Write-Output 'App Installer installed with Repair-WinGetPackageManager.'; return }
    } catch { Write-Output "Repair-WinGetPackageManager didn't work: $_" }
    # Method 2: Microsoft's release package and its dependencies, provisioned for all users
    try {
        $tmp = Join-Path $env:TEMP ('nexpatchonline-winget-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $tmp -Force | Out-Null
        $bundle = Join-Path $tmp 'AppInstaller.msixbundle'
        $depsZip = Join-Path $tmp 'Dependencies.zip'
        Invoke-WebRequest -Uri 'https://aka.ms/getwinget' -OutFile $bundle -UseBasicParsing
        Invoke-WebRequest -Uri 'https://github.com/microsoft/winget-cli/releases/latest/download/DesktopAppInstaller_Dependencies.zip' -OutFile $depsZip -UseBasicParsing
        Expand-Archive -Path $depsZip -DestinationPath (Join-Path $tmp 'deps') -Force
        $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
        $deps = @(Get-ChildItem -Path (Join-Path $tmp 'deps') -Recurse -Filter '*.appx' | Where-Object { $_.Directory.Name -eq $arch } | ForEach-Object { $_.FullName })
        Add-AppxProvisionedPackage -Online -PackagePath $bundle -DependencyPackagePath $deps -SkipLicense | Out-Null
        Remove-Item -Path $tmp -Recurse -Force -ErrorAction SilentlyContinue
        if (Find-Winget) { Write-Output 'App Installer installed from the Microsoft release package.' }
    } catch { Write-Output "Installing the App Installer release package didn't work: $_" }
}

$exit = 0
try {
    $Winget = Find-Winget
    if (-not $Winget) { Install-AppInstaller; $Winget = Find-Winget }
    if (-not $Winget) { Write-Output 'winget (App Installer) could not be installed on this device. Check internet access to PowerShell Gallery, aka.ms and github.com, or install App Installer from the Microsoft Store.'; Stop-Transcript | Out-Null; exit 2 }
    Write-Output "Using winget at $($Winget.FullName)"
    Set-Location -Path $Winget.DirectoryName   # winget finds its runtime files from its own folder when run as SYSTEM

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

    $common = @('--id', $Id, '--exact', '--source', 'winget', '--silent', '--scope', 'machine', '--accept-source-agreements', '--disable-interactivity')
    if ($Uninstall) {
        & $Winget.FullName uninstall @common
        $exit = $LASTEXITCODE
        if ($exit -eq -1978335212) { $exit = 0 }   # not installed
    } else {
        Invoke-Embedded $PreScript 'pre-install'
        & $Winget.FullName __ACTION__ @common --accept-package-agreements
        $exit = $LASTEXITCODE
        Write-Output "winget finished with exit code $exit"
        if ($exit -eq -1978335189 -or $exit -eq -1978335135) { $exit = 0 }   # no newer version / already installed
        if ($exit -eq 0) { Invoke-Embedded $PostScript 'post-install' }
    }
} catch {
    Write-Output "Error: $_"
    Write-Output $_.ScriptStackTrace
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


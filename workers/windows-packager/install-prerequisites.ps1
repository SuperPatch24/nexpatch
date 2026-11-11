# Run elevated on a dedicated Windows Server 2022/2025 packaging worker.
$ErrorActionPreference='Stop'
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope LocalMachine -Force
Install-PackageProvider -Name NuGet -Force
Install-Module Az.Accounts -Scope AllUsers -Force -AllowClobber
Install-Module Az.Storage -Scope AllUsers -Force -AllowClobber
if(-not (Get-Command Update-MpSignature -ErrorAction SilentlyContinue)){throw 'Microsoft Defender Antivirus cmdlets are unavailable. Use a supported Windows Server image with Defender enabled.'}
Update-MpSignature
New-Item -ItemType Directory -Force -Path 'C:\NexpatchWorker','D:\NexpatchWork' | Out-Null
Write-Host 'Prerequisites installed. Download Microsoft Win32 Content Prep Tool from its official Microsoft GitHub repository and place IntuneWinAppUtil.exe in C:\NexpatchWorker\Microsoft-Win32-Content-Prep-Tool\.'
Write-Host 'Copy worker.ps1, test-in-hyperv.ps1 and a privately secured worker.config.json to C:\NexpatchWorker.'

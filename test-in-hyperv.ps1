[CmdletBinding()]
param(
 [Parameter(Mandatory)][string]$VMName,
 [Parameter(Mandatory)][string]$InstallerPath,
 [Parameter(Mandatory)][ValidateSet('msi','exe')][string]$InstallerType,
 [string]$InstallCommand,
 [string]$UninstallCommand,
 [Parameter(Mandatory)][string]$CredentialUser,
 [Parameter(Mandatory)][string]$CredentialPassword
)
$ErrorActionPreference='Stop'
Import-Module Hyper-V -ErrorAction Stop
$vm=Get-VM -Name $VMName -ErrorAction Stop
$networkSwitches=@(Get-VMNetworkAdapter -VM $vm | ForEach-Object { $_.SwitchName } | Where-Object { $_ })
if($vm.State -ne 'Off'){Stop-VM -VM $vm -TurnOff -Force}
$checkpointName="NexpatchBaseline-$([guid]::NewGuid().ToString('N'))"
Checkpoint-VM -VM $vm -SnapshotName $checkpointName | Out-Null
$session=$null
try {
 # Disconnect every virtual NIC before starting untrusted installer code.
 Get-VMNetworkAdapter -VM $vm | Disconnect-VMNetworkAdapter
 Start-VM -VM $vm | Out-Null
 $deadline=(Get-Date).AddMinutes(5)
 do { Start-Sleep -Seconds 5; try {$session=New-PSSession -VMName $VMName -Credential (New-Object System.Management.Automation.PSCredential($CredentialUser,(ConvertTo-SecureString $CredentialPassword -AsPlainText -Force)));}catch{} } while(-not $session -and (Get-Date) -lt $deadline)
 if(-not $session){throw 'Could not establish PowerShell Direct session to isolated test VM.'}
 $guestDir='C:\NexpatchTest'
 Invoke-Command -Session $session -ScriptBlock {param($d) New-Item -ItemType Directory -Force -Path $d | Out-Null} -ArgumentList $guestDir
 $guestInstaller=Join-Path $guestDir (Split-Path -Leaf $InstallerPath)
 Copy-Item -ToSession $session -Path $InstallerPath -Destination $guestInstaller -Force
 $result=Invoke-Command -Session $session -ScriptBlock {
   param($path,$kind,$install,$uninstall)
   $log='C:\NexpatchTest\install-test.log'
   if($kind -eq 'msi') {
     $p=Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i',('"'+$path+'"'),'/qn','/norestart','/l*v',('"'+$log+'"')) -Wait -PassThru
   } else {
     if([string]::IsNullOrWhiteSpace($install)){throw 'EXE requires an explicit silent install command for isolated testing.'}
     # Commands are supplied by the tenant administrator and run only inside this disposable, network-disconnected VM.
     $p=Start-Process -FilePath $path -ArgumentList $install -Wait -PassThru
   }
   if($p.ExitCode -notin @(0,3010,1641)){throw "Install test failed with exit code $($p.ExitCode)."}
   if($kind -eq 'msi') {$u=Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/x',('"'+$path+'"'),'/qn','/norestart') -Wait -PassThru}
   else {if([string]::IsNullOrWhiteSpace($uninstall)){throw 'EXE requires an explicit silent uninstall command for isolated testing.'};$u=Start-Process -FilePath 'cmd.exe' -ArgumentList @('/d','/s','/c',$uninstall) -Wait -PassThru}
   if($u.ExitCode -notin @(0,3010,1641,1605)){throw "Uninstall test failed with exit code $($u.ExitCode)."}
   [pscustomobject]@{InstallExitCode=$p.ExitCode;UninstallExitCode=$u.ExitCode}
 } -ArgumentList $guestInstaller,$InstallerType,$InstallCommand,$UninstallCommand
 Write-Output ($result | ConvertTo-Json -Compress)
 exit 0
} finally {
 if($session){Remove-PSSession $session -ErrorAction SilentlyContinue}
 if((Get-VM -Name $VMName).State -ne 'Off'){Stop-VM -Name $VMName -TurnOff -Force -ErrorAction SilentlyContinue}
 Restore-VMSnapshot -VMName $VMName -Name $checkpointName -Confirm:$false | Out-Null
 for($i=0;$i -lt $networkSwitches.Count;$i++){ $adapter=Get-VMNetworkAdapter -VMName $VMName | Select-Object -Index $i; if($adapter -and $networkSwitches[$i]){Connect-VMNetworkAdapter -VMNetworkAdapter $adapter -SwitchName $networkSwitches[$i]} }
 Remove-VMSnapshot -VMName $VMName -Name $checkpointName -Confirm:$false | Out-Null
}

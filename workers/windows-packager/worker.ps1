# NexpatchOnline Windows packaging worker
# Run only on a dedicated, hardened Windows Server VM. Never run customer installers on the API host.
# Requires Az.Accounts, Az.Storage, Microsoft Defender Antivirus, and Microsoft's Win32 Content Prep Tool.
[CmdletBinding()]
param([string]$ConfigPath = "$PSScriptRoot\worker.config.json")
$ErrorActionPreference = 'Stop'
$config = Get-Content -Raw $ConfigPath | ConvertFrom-Json
if($env:NEXPATCH_STORAGE_CONNECTION){$config.StorageConnectionString=$env:NEXPATCH_STORAGE_CONNECTION}
if($env:NEXPATCH_WORKER_TOKEN){$config.WorkerToken=$env:NEXPATCH_WORKER_TOKEN}
if($env:NEXPATCH_TEST_VM_PASSWORD){$config.TestVmCredentialPassword=$env:NEXPATCH_TEST_VM_PASSWORD}
foreach($key in @('StorageConnectionString','ApiBaseUrl','WorkerToken','IntuneWinAppUtilPath')) { if(-not $config.$key) { throw "Missing worker configuration: $key" } }
Import-Module Az.Storage -ErrorAction Stop
$ctx = New-AzStorageContext -ConnectionString $config.StorageConnectionString
$queue = Get-AzStorageQueue -Name 'nexpatch-packaging-jobs' -Context $ctx -ErrorAction SilentlyContinue
if(-not $queue) { throw 'Packaging queue does not exist. Deploy the API and initialize storage before starting the worker.' }
$null = New-AzStorageContainer -Name 'nexpatch-packaging-artifacts' -Context $ctx -Permission Off -ErrorAction SilentlyContinue
$null = New-Item -ItemType Directory -Force -Path $config.WorkRoot

function Send-Result($job,$body) {
  $body.tenantId = $job.tenantId
  $uri = "$($config.ApiBaseUrl.TrimEnd('/'))/api/packaging/worker/jobs/$($job.jobId)/complete"
  Invoke-RestMethod -Method Post -Uri $uri -Headers @{'x-packaging-worker-token'=$config.WorkerToken} -ContentType 'application/json' -Body ($body | ConvertTo-Json -Depth 8) | Out-Null
}
function Get-QueueText($message) { $raw=[string]$message.AsString; try { $null=$raw | ConvertFrom-Json; return $raw } catch { $decoded=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($raw)); $null=$decoded | ConvertFrom-Json; return $decoded } }
function Remove-QueueMessage($message) { $queue.QueueClient.DeleteMessageAsync($message.Id,$message.PopReceipt).GetAwaiter().GetResult() | Out-Null } 

Write-Host "Nexpatch Windows packager started. Poll interval: $($config.PollSeconds)s"
while($true) {
  $messages = $queue.QueueClient.GetMessagesAsync(1,[TimeSpan]::FromHours(4),$null,$null).GetAwaiter().GetResult()
  if(-not $messages) { Start-Sleep -Seconds ([Math]::Max(5,[int]$config.PollSeconds)); continue }
  $m = $messages[0]; $job=$null; $work=Join-Path $config.WorkRoot ([guid]::NewGuid().ToString('N')); $source=Join-Path $work 'source'; $output=Join-Path $work 'output'
  try {
    $job=Get-QueueText $m | ConvertFrom-Json
    if($m.DequeueCount -gt 4){ Send-Result $job @{status='worker-error';stage='retry-limit';scanStatus='unknown';signatureStatus='unknown';packageStatus='not-created';testStatus='not-run';error='Packaging job exceeded the worker retry limit. Review worker and storage logs.'}; Remove-QueueMessage $m; continue }
    $rowUri="$($config.ApiBaseUrl.TrimEnd('/'))/api/packaging/jobs" # tenant-scoped metadata is held in the queue; worker accesses blobs directly.
    $container=Get-AzStorageContainer -Name 'nexpatch-packaging-quarantine' -Context $ctx
    $jobMetaBlob=$null
    # Queue payload is deliberately minimal. Metadata file is written by the upload API alongside the installer.
    $jobFile=Join-Path $work 'job.json'
    New-Item -ItemType Directory -Force -Path $source,$output | Out-Null
    # Worker API hands off a one-time download SAS through a job manifest blob.
    $manifestName="$($job.tenantId)/$($job.jobId).json"
    Get-AzStorageBlobContent -Container 'nexpatch-packaging-manifests' -Blob $manifestName -Destination $jobFile -Context $ctx -Force | Out-Null
    $meta=Get-Content -Raw $jobFile | ConvertFrom-Json
    $inputPath=Join-Path $source $meta.fileName
    Get-AzStorageBlobContent -Container 'nexpatch-packaging-quarantine' -Blob $meta.blobName -Destination $inputPath -Context $ctx -Force | Out-Null
    $actual=(Get-FileHash -Algorithm SHA256 -LiteralPath $inputPath).Hash.ToLowerInvariant()
    if($actual -ne [string]$meta.sha256) { throw 'SHA-256 mismatch. The quarantine file changed after upload finalization.' }
    $signature=Get-AuthenticodeSignature -LiteralPath $inputPath
    $sigStatus=[string]$signature.Status
    if($signature.Status -ne 'Valid') {
      Send-Result $job @{status='signature-rejected';stage='signature-check';scanStatus='not-run';signatureStatus=$sigStatus;packageStatus='not-created';testStatus='not-run';sha256=$actual;error='Authenticode signature is not valid. Unsigned installers require an explicit platform review path and are not packaged automatically.'}
      Remove-QueueMessage $m; continue
    }
    # Microsoft Defender Antivirus custom scan; worker image must have real-time protection and signatures current.
    Update-MpSignature -ErrorAction Stop
    Start-MpScan -ScanType CustomScan -ScanPath $inputPath -ErrorAction Stop
    $detections=Get-MpThreatDetection -ErrorAction SilentlyContinue | Where-Object { $_.Resources -match [regex]::Escape($inputPath) }
    if($detections) {
      Send-Result $job @{status='scan-failed';stage='malware-scan';scanStatus='threat-detected';signatureStatus=$sigStatus;packageStatus='not-created';testStatus='not-run';sha256=$actual;error='Microsoft Defender reported a threat in the uploaded installer.'}
      Remove-QueueMessage $m; continue
    }
    $tool=$config.IntuneWinAppUtilPath
    if(-not (Test-Path -LiteralPath $tool)) { throw 'Microsoft Win32 Content Prep Tool not found at IntuneWinAppUtilPath.' }
    $arguments=@('-c',$source,'-s',(Split-Path -Leaf $inputPath),'-o',$output,'-q')
    & $tool -c $source -s (Split-Path -Leaf $inputPath) -o $output -q
    if($LASTEXITCODE -ne 0) { throw "IntuneWinAppUtil failed with exit code $LASTEXITCODE." }
    $artifact=Get-ChildItem -LiteralPath $output -Filter '*.intunewin' -File | Select-Object -First 1
    if(-not $artifact) { throw 'IntuneWinAppUtil completed without producing an .intunewin file.' }
    $artifactBlob="$($job.tenantId)/$($job.jobId)/$($artifact.Name)"
    $artifactHash=(Get-FileHash -Algorithm SHA256 -LiteralPath $artifact.FullName).Hash.ToLowerInvariant()
    Set-AzStorageBlobContent -File $artifact.FullName -Container 'nexpatch-packaging-artifacts' -Blob $artifactBlob -Context $ctx -Force | Out-Null
    # Test original installer in a disposable, network-disconnected Hyper-V guest. The guest is reverted after every run.
    $testStatus='not-configured'; $finalStatus='packaged-awaiting-test'; $testError=''
    if($config.EnableHyperVTest -eq $true -and $config.TestVmName -and $config.TestVmCredentialUser -and $config.TestVmCredentialPassword) {
      try {
        $testArgs=@('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $PSScriptRoot 'test-in-hyperv.ps1'),'-VMName',$config.TestVmName,'-InstallerPath',$inputPath,'-InstallerType',$meta.installerType,'-InstallCommand',$meta.installCommand,'-UninstallCommand',$meta.uninstallCommand,'-CredentialUser',$config.TestVmCredentialUser,'-CredentialPassword',$config.TestVmCredentialPassword)
        & powershell.exe @testArgs
        $testExit=$LASTEXITCODE
        if($testExit -eq 0){$testStatus='passed';$finalStatus='test-passed'}else{$testStatus='failed';$finalStatus='test-failed';$testError="Isolated VM test returned exit code $testExit."}
      } catch {$testStatus='failed';$finalStatus='test-failed';$testError=$_.Exception.Message}
    }
    Send-Result $job @{status=$finalStatus;stage= $(if($testStatus -eq 'passed'){'isolated-test-passed'}elseif($testStatus -eq 'failed'){'isolated-test-failed'}else{'packaging-complete'});scanStatus='clean';signatureStatus=$sigStatus;packageStatus='created';testStatus=$testStatus;sha256=$actual;artifactBlobName=$artifactBlob;artifactName=$artifact.Name;artifactSha256=$artifactHash;signatureSubject=[string]$signature.SignerCertificate.Subject;error= $(if($testError){$testError}else{'Security checks and package conversion completed. Customer approval is still required before publication or deployment.'})}
    Remove-QueueMessage $m
  } catch {
    Write-Error $_
    if($job) { try { Send-Result $job @{status='worker-error';stage='worker-error';scanStatus='unknown';signatureStatus='unknown';packageStatus='not-created';testStatus='not-run';error=$_.Exception.Message} } catch { Write-Error "Unable to report worker failure: $_" } }
    # Leave message for poison queue/retry policy; avoid deleting on transient failures.
  } finally { if(Test-Path $work){Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue} }
}

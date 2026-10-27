# CampusPay X PM2 crash-recovery verification
# LOCAL DEVELOPMENT ONLY. This test deliberately crashes the Node.js process.
# Prerequisite: run `pm2 start ecosystem.config.js` from the project root first.

$ErrorActionPreference = "Stop"
$BaseUrl = if ($env:CAMPUSPAY_URL) { $env:CAMPUSPAY_URL.TrimEnd('/') } else { "http://localhost:5000" }
$StartedAt = Get-Date

function Write-Stage([string]$Message) {
  Write-Host ("[{0}] {1}" -f (Get-Date -Format "HH:mm:ss.fff"), $Message) -ForegroundColor Cyan
}

Write-Host "`nCampusPay X - PM2 crash and recovery test" -ForegroundColor Green
Write-Host "Target: $BaseUrl"
Write-Host "WARNING: the test deliberately terminates the local Node.js process." -ForegroundColor Yellow
Write-Host "PM2 must already be supervising the application. Do not use against production." -ForegroundColor Yellow

Write-Stage "Checking pre-crash health"
$health = Invoke-RestMethod -Method Get -Uri "$BaseUrl/api/health" -TimeoutSec 5
if ($health.status -ne "healthy") {
  throw "Backend is not healthy. Test stopped before crash: $($health | ConvertTo-Json -Compress)"
}

Write-Stage "Preparing a pending transaction with persisted simulated gateway outcome"
$prepared = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/dev/prepare-crash-recovery" -ContentType "application/json" -Body "{}" -TimeoutSec 10
$transactionId = $prepared.transaction.transactionId
if (-not $transactionId) { throw "Preparation response did not contain transaction.transactionId." }
Write-Host "Transaction: $transactionId" -ForegroundColor Green

Write-Stage "Triggering deliberate crash; watch PM2 logs in another terminal"
try {
  Invoke-WebRequest -Method Post -Uri "$BaseUrl/api/dev/crash" -ContentType "application/json" -Body "{}" -TimeoutSec 5 | Out-Null
} catch {
  # Expected in many runs because the process exits and closes the connection.
  Write-Host "Crash request disconnected; waiting for PM2 restart." -ForegroundColor Yellow
}

$RecoveredHealthAt = $null
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 1
  try {
    $health = Invoke-RestMethod -Method Get -Uri "$BaseUrl/api/health" -TimeoutSec 2
    if ($health.status -eq "healthy") {
      $RecoveredHealthAt = Get-Date
      break
    }
  } catch {}
}
if (-not $RecoveredHealthAt) {
  throw "Server did not become healthy within 30 seconds. Run: pm2 status; pm2 logs campuspay-x --lines 100"
}

Write-Stage "Health endpoint recovered; checking original transaction"
$payments = Invoke-RestMethod -Method Get -Uri "$BaseUrl/api/payments" -TimeoutSec 5
$tx = $payments | Where-Object { $_.transactionId -eq $transactionId } | Select-Object -First 1
if (-not $tx) { throw "Transaction $transactionId was not found after restart." }

$eventsUri = [System.UriBuilder]::new("$BaseUrl/api/reliability/events")
$query = "limit=80" + [char]38 + "transactionId=$transactionId"
$eventsUri.Query = $query
$events = Invoke-RestMethod -Method Get -Uri $eventsUri.Uri.AbsoluteUri -TimeoutSec 5
$verified = $events | Where-Object { $_.eventType -eq "RECOVERY_VERIFIED" } | Select-Object -First 1

$elapsedSeconds = [math]::Round(((Get-Date) - $StartedAt).TotalSeconds, 2)


$elapsedSeconds = [math]::Round(((Get-Date) - $StartedAt).TotalSeconds, 2)

Write-Host ""
Write-Host "--- RESULT ---" -ForegroundColor Green
Write-Host ("Transaction ID : {0}" -f $transactionId)
Write-Host ("Final status   : {0}" -f $tx.status)
Write-Host ("Total test time: {0} seconds" -f $elapsedSeconds)
Write-Host ("Health restored: {0}" -f $RecoveredHealthAt.ToString("yyyy-MM-dd HH:mm:ss.fff"))

if ($verified) {
    $recoveryEvent = "RECOVERY_VERIFIED found"
} else {
    $recoveryEvent = "NOT FOUND"
}

Write-Host ("Recovery event : {0}" -f $recoveryEvent)

if (($tx.status -eq "SIMULATED_SUCCESS") -and $verified) {
    Write-Host "PASS: PM2 restart and transaction recovery verified." -ForegroundColor Green
    exit 0
}

Write-Host "FAIL: Transaction recovery was not verified." -ForegroundColor Red

if ($events) {
    $events | Select-Object eventType, stage, message | Format-Table -AutoSize
}

exit 1

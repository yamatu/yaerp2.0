param(
  [string]$BaseUrl = "http://127.0.0.1:5555",
  [string]$PprofToken = $env:PPROF_TOKEN,
  [int]$Samples = 30,
  [int]$IntervalSeconds = 2,
  [string]$OutputDir = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($OutputDir)) {
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $OutputDir = Join-Path (Get-Location) "memory-$stamp"
}
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$headers = @{}
if (-not [string]::IsNullOrWhiteSpace($PprofToken)) {
  $headers["X-Pprof-Token"] = $PprofToken
}

$metricsPath = Join-Path $OutputDir "metrics.jsonl"
$statsPath = Join-Path $OutputDir "docker-stats.jsonl"

Write-Host "Writing samples to $OutputDir"
Write-Host "Run the repeatable workbook workload while this script is sampling."

for ($i = 0; $i -lt $Samples; $i++) {
  $timestamp = (Get-Date).ToUniversalTime().ToString("o")
  try {
    $metrics = Invoke-RestMethod -Uri "$BaseUrl/debug/metrics" -Headers $headers
    [pscustomobject]@{ timestamp = $timestamp; metrics = $metrics } |
      ConvertTo-Json -Compress -Depth 12 | Add-Content -Path $metricsPath
  } catch {
    [pscustomobject]@{ timestamp = $timestamp; error = $_.Exception.Message } |
      ConvertTo-Json -Compress | Add-Content -Path $metricsPath
  }

  try {
    $stats = docker stats --no-stream --format '{{json .}}' 2>$null
    foreach ($line in $stats) {
      [pscustomobject]@{ timestamp = $timestamp; container = ($line | ConvertFrom-Json) } |
        ConvertTo-Json -Compress -Depth 8 | Add-Content -Path $statsPath
    }
  } catch {
    [pscustomobject]@{ timestamp = $timestamp; error = $_.Exception.Message } |
      ConvertTo-Json -Compress | Add-Content -Path $statsPath
  }

  if ($i -lt ($Samples - 1)) {
    Start-Sleep -Seconds $IntervalSeconds
  }
}

foreach ($profile in @("heap", "goroutine?debug=2")) {
  $safeName = $profile -replace "[^a-zA-Z0-9]", "-"
  $target = Join-Path $OutputDir "$safeName.txt"
  if ($profile -eq "heap") { $target = Join-Path $OutputDir "heap.pb.gz" }
  try {
    Invoke-WebRequest -Uri "$BaseUrl/debug/pprof/$profile" -Headers $headers -OutFile $target
  } catch {
    Write-Warning "Could not capture $profile : $($_.Exception.Message)"
  }
}

Write-Host "Done. Compare metrics.jsonl with docker-stats.jsonl and inspect heap.pb.gz using:"
Write-Host "  go tool pprof -top $OutputDir/heap.pb.gz"

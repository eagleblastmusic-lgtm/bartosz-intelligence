param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^\d{4}-\d{2}-\d{2}/([01]\d|2[0-3]):[0-5]\d$')]
  [string]$Window,

  [ValidateSet('all', 'DirectCaptionsEdge', 'youtube-transcript-api', 'yt-dlp captions-only')]
  [string]$Provider = 'all'
)

$ErrorActionPreference = 'Stop'
$env:WRANGLER_WRITE_LOGS = 'false'
$env:WRANGLER_LOG_SANITIZE = 'true'
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$nodeExecutable = Join-Path $repositoryRoot '.tools/node-v24.21.0-win-x64/node.exe'
$configPath = 'tools/gates/adapters/wrangler.gate0.jsonc'
$resultsPath = 'docs/verification/gate-0/results.jsonl'
$previewEvidencePath = 'docs/verification/gate-0/preview-runs.jsonl'
$previewName = $null
$preview = $null
$previewCreated = $false
$runnerResult = $null
$stderrPath = Join-Path $repositoryRoot ('.tools/gate0-preview-' + [guid]::NewGuid().ToString('N') + '.stderr.log')
$tokenBytes = New-Object byte[] 32
$token = $null
$exitCode = 0

try {
  if (-not (Test-Path -LiteralPath $nodeExecutable -PathType Leaf)) {
    throw 'PINNED_NODE_NOT_FOUND'
  }

  $gate0Manifest = Get-Content -Raw -LiteralPath 'docs/verification/gate-0/MANIFEST.json' | ConvertFrom-Json
  $parts = $Window -split '/'
  if ($parts[1] -notin $gate0Manifest.retry_windows_local) {
    throw 'WINDOW_NOT_PREREGISTERED'
  }
  $warsawTimezone = [TimeZoneInfo]::FindSystemTimeZoneById('Central European Standard Time')
  $localNow = [TimeZoneInfo]::ConvertTimeFromUtc([DateTime]::UtcNow, $warsawTimezone)
  $windowStart = [DateTime]::ParseExact($Window, 'yyyy-MM-dd/HH:mm', [Globalization.CultureInfo]::InvariantCulture)
  if ($localNow -lt $windowStart -or $localNow -ge $windowStart.AddHours(1)) {
    throw 'LIVE_OUTSIDE_SCHEDULED_WINDOW'
  }

  $parts = $Window -split '/'
  $previewName = 'gate0-cp16-{0}-{1}-{2}' -f $parts[0].Replace('-', ''), $parts[1].Replace(':', ''), ([guid]::NewGuid().ToString('N').Substring(0, 8))
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($tokenBytes)
  $token = [Convert]::ToBase64String($tokenBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
  $bindingArgument = 'GATE0_BENCH_TOKEN:' + $token

  $previewArguments = @(
    'node_modules/wrangler/bin/wrangler.js',
    'preview',
    '--config', $configPath,
    '--name', $previewName,
    '--message', 'Stage 01 Gate 0 live benchmark',
    '--var', $bindingArgument,
    '--json'
  )
  $previewOutput = & $nodeExecutable @previewArguments 2> $stderrPath
  if ($LASTEXITCODE -ne 0) {
    throw 'PREVIEW_CREATE_FAILED'
  }
  $previewCreated = $true
  . (Join-Path $PSScriptRoot 'adapters/gate0-preview-result.ps1')
  $preview = ConvertFrom-Gate0PreviewResult -Json ($previewOutput -join "`n") -ExpectedName $previewName
  if (
    $preview.preview_name -ne $previewName -or
    -not $preview.preview_slug -or
    -not $preview.preview_id -or
    -not $preview.deployment_id
  ) {
    throw 'PREVIEW_RESULT_INVALID'
  }
  $previewUrl = @($preview.preview_urls | Where-Object { $_ } | Select-Object -First 1)[0]
  if (-not $previewUrl) {
    throw 'PREVIEW_URL_MISSING'
  }
  $previewUri = [Uri]$previewUrl
  if ($previewUri.Scheme -ne 'https' -or -not $previewUri.Host.ToLowerInvariant().EndsWith('.workers.dev')) {
    throw 'PREVIEW_URL_NOT_CLOUDFLARE_WORKERS_DEV'
  }

  $env:GATE0_BENCH_TOKEN = $token
  $runnerArguments = @(
    'node_modules/tsx/dist/cli.mjs',
    'tools/gates/transcript-bench-live.ts',
    'run',
    '--window', $Window,
    '--provider', $Provider,
    '--edge-url', $previewUrl,
    '--results', $resultsPath
  )
  $runnerOutput = & $nodeExecutable @runnerArguments
  if ($LASTEXITCODE -ne 0) {
    throw 'GATE0_RUNNER_FAILED'
  }
  $runnerResult = ($runnerOutput | Select-Object -Last 1) | ConvertFrom-Json
  if ($runnerResult.result -ne 'WINDOW_RECORDED') {
    throw 'GATE0_RUNNER_RESULT_INVALID'
  }
  $runnerOutput | ForEach-Object { Write-Output $_ }
} catch {
  $safeCode = if ($_.Exception.Message -match '^[A-Z0-9_]+$') {
    $_.Exception.Message
  } else {
    'GATE0_WINDOW_FAILED'
  }
  Write-Output (@{ result = 'FAILED'; reason_code = $safeCode } | ConvertTo-Json -Compress)
  $exitCode = 2
} finally {
  Remove-Item Env:\GATE0_BENCH_TOKEN -ErrorAction SilentlyContinue
  if ($previewCreated -and ($null -eq $preview -or -not $preview.preview_slug)) {
    & $nodeExecutable `
      node_modules/wrangler/bin/wrangler.js `
      preview delete `
      --config $configPath `
      --name $previewName `
      --skip-confirmation `
      2> $stderrPath | Out-Null
    if ($LASTEXITCODE -ne 0) {
      Write-Output (@{ result = 'FAILED'; reason_code = 'PREVIEW_CLEANUP_FAILED' } | ConvertTo-Json -Compress)
      $exitCode = 2
    }
  }
  if ($null -ne $preview -and $preview.preview_id -and $preview.preview_slug) {
    $record = [ordered]@{
      schema_version = 'gate0-preview-run-1.0'
      window = $Window
      provider = $Provider
      preview_name = $preview.preview_name
      preview_id = $preview.preview_id
      preview_slug = $preview.preview_slug
      worker_name = $preview.worker_name
      deployment_id = $preview.deployment_id
      preview_url_host = if ($previewUrl) { ([Uri]$previewUrl).Host } else { $null }
      deployed_at = $localNow.ToString('o')
      result = if ($runnerResult) { $runnerResult.result } else { 'INCOMPLETE' }
      cleanup_status = 'PENDING_CPU_CAPTURE'
    }
    Add-Content -LiteralPath $previewEvidencePath -Value ($record | ConvertTo-Json -Compress)
  }
  [Array]::Clear($tokenBytes, 0, $tokenBytes.Length)
  $token = $null
  Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue
}

if ($exitCode -ne 0) {
  exit $exitCode
}

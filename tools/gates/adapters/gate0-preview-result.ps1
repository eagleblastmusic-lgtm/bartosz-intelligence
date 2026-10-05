function ConvertFrom-Gate0PreviewResult {
  param([Parameter(Mandatory = $true)] [string]$Json, [Parameter(Mandatory = $true)] [string]$ExpectedName)
  $parsed = $Json | ConvertFrom-Json
  if ($parsed.preview.name -ne $ExpectedName -or -not $parsed.preview.id -or -not $parsed.preview.slug -or -not $parsed.deployment.id) {
    throw 'PREVIEW_RESULT_INVALID'
  }
  # Keep only non-secret metadata; deployment.env/bindings must never be persisted.
  return [pscustomobject]@{
    preview_name = $parsed.preview.name
    preview_id = $parsed.preview.id
    preview_slug = $parsed.preview.slug
    preview_urls = @($parsed.preview.urls)
    deployment_id = $parsed.deployment.id
    worker_name = 'bartosz-intelligence-gate0-cp16'
  }
}

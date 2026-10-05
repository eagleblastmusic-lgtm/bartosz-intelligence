$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../../tools/gates/adapters/gate0-preview-result.ps1')
$fixture = '{"preview":{"id":"fixture-id","name":"fixture-name","slug":"fixture-slug","urls":["https://fixture.workers.dev"]},"deployment":{"id":"deployment-id","env":{"vars":{"GATE0_BENCH_TOKEN":"fixture-sensitive-value"}}}}'
$result = ConvertFrom-Gate0PreviewResult -Json $fixture -ExpectedName 'fixture-name'
if ($result.preview_id -ne 'fixture-id' -or $result.deployment_id -ne 'deployment-id' -or $result.preview_urls[0] -ne 'https://fixture.workers.dev') { throw 'VALID_FIXTURE_NOT_PARSED' }
if (($result | ConvertTo-Json -Depth 10) -match 'fixture-sensitive-value|env|vars') { throw 'SENSITIVE_DEPLOYMENT_FIELDS_RETAINED' }
$rejected = $false
try { ConvertFrom-Gate0PreviewResult -Json $fixture -ExpectedName 'wrong-name' | Out-Null } catch { $rejected = $_.Exception.Message -eq 'PREVIEW_RESULT_INVALID' }
if (-not $rejected) { throw 'WRONG_PREVIEW_IDENTITY_ACCEPTED' }
Write-Output 'PREVIEW_PARSER_FIXTURES_PASS'

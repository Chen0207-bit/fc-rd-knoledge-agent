$ErrorActionPreference = "Stop"
$api = "https://fc-rd-knowledge-agent-api.feng85656.workers.dev"
$headers = @{ "x-demo-code" = "YANZHI-8264" }

$health = Invoke-RestMethod -Uri "$api/api/health"
if (-not $health.ok) { throw "API health check failed" }

$unauthorized = $false
try {
  Invoke-RestMethod -Uri "$api/api/stats" -Headers @{ "x-demo-code" = "wrong-code" } | Out-Null
} catch { $unauthorized = $_.Exception.Response.StatusCode.value__ -eq 401 }
if (-not $unauthorized) { throw "Unauthorized request was not rejected" }

$stats = Invoke-RestMethod -Uri "$api/api/stats" -Headers $headers
$search = Invoke-RestMethod -Uri "$api/api/papers/search?q=research%20agent&limit=2" -Headers $headers
if ($search.papers.Count -lt 1) { throw "Paper search returned no results" }

[pscustomobject]@{
  Health = $health.ok
  UnauthorizedRejected = $unauthorized
  SearchResults = $search.papers.Count
  Sources = (($search.papers.source | Sort-Object -Unique) -join ",")
  Discovered = $stats.discovered
  Approved = $stats.approved
  Documents = $stats.documents
  Drafts = $stats.drafts
} | Format-List

<#
  The agent on the owner's Windows computer. It asks tars for approved coding
  tasks, runs each one with this computer's own `claude` login in a fresh git
  worktree, and reports the outcome back. It only makes outbound HTTPS calls;
  nothing listens here.

  Run:   powershell -NoProfile -ExecutionPolicy Bypass -File tars-agent.ps1
  Stop:  Ctrl+C
  Setup: docs/agent.md
#>
param(
  [string]$Server = 'https://lia.bebars.uz',
  [string]$ProjectsDir = 'D:\projects',
  [string]$TokenFile = (Join-Path $env:USERPROFILE '.tars-agent-token'),
  [int]$PollSeconds = 10
)

# UTF-8 both ways, so Uzbek and other non-ASCII text survives the trip to claude and back.
$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# The work must run on this computer's claude login, not on a key or token that happens to be in the environment.
Remove-Item Env:ANTHROPIC_API_KEY, Env:CLAUDE_CODE_OAUTH_TOKEN -ErrorAction SilentlyContinue

$token = (Get-Content -Raw -Path $TokenFile -ErrorAction Stop).Trim()
$headers = @{ Authorization = "Bearer $token" }

function Log([string]$text) {
  Write-Host "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $text"
}

function Post([string]$path, $body) {
  $json = ConvertTo-Json $body -Compress -Depth 5
  Invoke-RestMethod -Method Post -Uri "$Server$path" -Headers $headers -ContentType 'application/json; charset=utf-8' `
    -Body ([Text.Encoding]::UTF8.GetBytes($json)) -TimeoutSec 60 -ErrorAction Stop
}

# Runs one task; returns @{ ok; summary } for tars.
function Invoke-Task($task) {
  $repo = Join-Path $ProjectsDir $task.repo
  if (-not (Test-Path (Join-Path $repo '.git'))) {
    return @{ ok = $false; summary = "There is no git repository at $repo on the owner's computer." }
  }
  $worktree = Join-Path $ProjectsDir ".lia-worktrees\$($task.repo)-$($task.id)"
  # Out-Host: git's output must not become part of what this function returns.
  git -C $repo worktree add --detach $worktree | Out-Host
  if ($LASTEXITCODE -ne 0) {
    return @{ ok = $false; summary = "git worktree add failed for $worktree (exit code $LASTEXITCODE)." }
  }
  Push-Location $worktree
  try {
    $output = $task.prompt | & claude -p --output-format json --permission-mode bypassPermissions
  } finally {
    Pop-Location
  }
  $text = $output -join "`n"
  try {
    $result = $text | ConvertFrom-Json -ErrorAction Stop
  } catch {
    return @{ ok = $false; summary = "claude did not finish normally. Its output:`n$text" }
  }
  if (-not $result.is_error) {
    # The branch is pushed by now; a worktree with leftovers stays for a look (remove refuses those).
    git -C $repo worktree remove $worktree | Out-Host
  }
  return @{ ok = -not $result.is_error; summary = [string]$result.result }
}

Log "polling $Server every $PollSeconds s; projects in $ProjectsDir (Ctrl+C to stop)"
while ($true) {
  $task = $null
  try {
    $task = Post '/agent/claim' @{}
  } catch {
    Log "could not reach tars: $($_.Exception.Message)"
  }
  if (-not $task) {
    Start-Sleep -Seconds $PollSeconds
    continue
  }
  Log "task #$($task.id) in $($task.repo): $($task.title)"
  try {
    $outcome = Invoke-Task $task
  } catch {
    $outcome = @{ ok = $false; summary = "The agent script failed: $($_.Exception.Message)" }
  }
  # A report that can't be delivered is retried: the task stays running on tars until it arrives.
  # A refusal (4xx) is final: retrying would get the same answer.
  while ($true) {
    try {
      Post "/agent/tasks/$($task.id)/result" $outcome | Out-Null
      Log "task #$($task.id) reported ($(if ($outcome.ok) { 'done' } else { 'failed' }))"
      break
    } catch {
      $status = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
      if ($status -ge 400 -and $status -lt 500) {
        Log "tars refused the report for task #$($task.id) (HTTP $status): $($_.Exception.Message)"
        break
      }
      Log "report for task #$($task.id) failed, retrying in 30 s: $($_.Exception.Message)"
      Start-Sleep -Seconds 30
    }
  }
}

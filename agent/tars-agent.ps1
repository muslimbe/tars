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

# The console log is for the owner, in Uzbek; it stays ASCII because PowerShell 5.1 reads a BOM-less script as ANSI.
function Log([string]$text, [string]$color = 'Gray') {
  Write-Host "  $(Get-Date -Format 'HH:mm:ss')  $text" -ForegroundColor $color
}

function Format-Duration([TimeSpan]$span) {
  if ($span.TotalMinutes -lt 1) { return "$([int]$span.TotalSeconds) s" }
  return "$([int][Math]::Floor($span.TotalMinutes)) daq $($span.Seconds) s"
}

function Post([string]$path, $body) {
  $json = ConvertTo-Json $body -Compress -Depth 5
  Invoke-RestMethod -Method Post -Uri "$Server$path" -Headers $headers -ContentType 'application/json; charset=utf-8' `
    -Body ([Text.Encoding]::UTF8.GetBytes($json)) -TimeoutSec 60 -ErrorAction Stop
}

# Where a task runs: a follow-up in its earlier worktree, a new task in a fresh one. Returns the path, or an error text.
function Get-Worktree($task) {
  if ($task.session_id) {
    if (Test-Path $task.worktree) { return @{ path = $task.worktree } }
    return @{ error = "The worktree $($task.worktree) of the session to continue is gone." }
  }
  $repo = Join-Path $ProjectsDir $task.repo
  if (-not (Test-Path (Join-Path $repo '.git'))) {
    return @{ error = "There is no git repository at $repo on the owner's computer." }
  }
  $worktree = Join-Path $ProjectsDir ".lia-worktrees\$($task.repo)-$($task.id)"
  # Captured, not printed: git's output is noise unless it fails, and must not become part of what this function returns.
  $gitOutput = git -C $repo worktree add --quiet --detach $worktree 2>&1
  if ($LASTEXITCODE -ne 0) { return @{ error = "git worktree add failed for ${worktree}:`n$($gitOutput -join "`n")" } }
  return @{ path = $worktree }
}

# Runs one task; returns the report for tars. The worktree stays, so the session can be continued there.
function Invoke-Task($task) {
  $where = Get-Worktree $task
  if ($where.error) { return @{ ok = $false; summary = $where.error } }
  Log "papka: $($where.path)"
  Log 'claude ishlayapti...'
  $claudeArgs = @('-p', '--output-format', 'json', '--permission-mode', 'bypassPermissions')
  if ($task.session_id) { $claudeArgs += @('--resume', $task.session_id) }
  if ($task.model) { $claudeArgs += @('--model', $task.model) }
  Push-Location $where.path
  try {
    $output = $task.prompt | & claude @claudeArgs
  } finally {
    Pop-Location
  }
  $text = $output -join "`n"
  try {
    $result = $text | ConvertFrom-Json -ErrorAction Stop
  } catch {
    return @{ ok = $false; summary = "claude did not finish normally. Its output:`n$text" }
  }
  $report = @{ ok = -not $result.is_error; summary = [string]$result.result }
  if ($result.session_id) {
    $quoted = $where.path -replace "'", "''"
    $report.session_id = [string]$result.session_id
    $report.worktree = $where.path
    $report.resume = "cd '$quoted'; Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue; claude --resume $($result.session_id)"
  }
  return $report
}

$rule = '=' * 72

function Show-Start($task) {
  $kind = if ($task.session_id) { '  (davomi)' } else { '' }
  $model = if ($task.model) { "  |  model: $($task.model)" } else { '' }
  Write-Host ''
  Write-Host $rule -ForegroundColor DarkCyan
  Write-Host " Vazifa #$($task.id)$kind  |  $($task.repo)$model  |  $(Get-Date -Format 'yyyy-MM-dd HH:mm')" -ForegroundColor Cyan
  Write-Host " $($task.title)" -ForegroundColor White
  Write-Host ('-' * 72) -ForegroundColor DarkCyan
}

# The outcome at a glance: the PR link when it worked, the first lines of the reason when it did not.
function Show-Outcome($outcome, [TimeSpan]$took) {
  $lines = @(([string]$outcome.summary) -split "`r?`n" | Where-Object { $_.Trim() })
  if ($outcome.ok) {
    Log "TAYYOR ($(Format-Duration $took))" Green
    $lines | Where-Object { $_ -match '^PR:' } | ForEach-Object { Write-Host "            $_" -ForegroundColor Green }
  } else {
    Log "XATO ($(Format-Duration $took))" Red
    $lines | Select-Object -First 5 | ForEach-Object { Write-Host "            $_" -ForegroundColor Red }
    if ($lines.Count -gt 5) { Write-Host "            ... (to'liq matn Lia xabarida)" -ForegroundColor DarkRed }
  }
}

# A report that can't be delivered is retried: the task stays running on tars until it arrives.
# A refusal (4xx) is final: retrying would get the same answer.
function Send-Report($task, $outcome) {
  while ($true) {
    try {
      Post "/agent/tasks/$($task.id)/result" $outcome | Out-Null
      Log "natija Lia'ga yuborildi"
      return
    } catch {
      $status = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
      if ($status -ge 400 -and $status -lt 500) {
        Log "Lia natijani qabul qilmadi (HTTP $status): $($_.Exception.Message)" Red
        return
      }
      Log "natijani yuborib bo'lmadi, 30 s dan keyin yana urinaman: $($_.Exception.Message)" Yellow
      Start-Sleep -Seconds 30
    }
  }
}

Write-Host "Lia agent ishga tushdi: $Server, har $PollSeconds s tekshiradi, loyihalar $ProjectsDir (to'xtatish: Ctrl+C)" -ForegroundColor Cyan
Log 'yangi vazifa kutilmoqda...' DarkGray
while ($true) {
  $task = $null
  try {
    $task = Post '/agent/claim' @{}
  } catch {
    Log "Lia bilan bog'lanib bo'lmadi: $($_.Exception.Message)" Yellow
  }
  if (-not $task) {
    Start-Sleep -Seconds $PollSeconds
    continue
  }
  Show-Start $task
  $clock = [Diagnostics.Stopwatch]::StartNew()
  try {
    $outcome = Invoke-Task $task
  } catch {
    $outcome = @{ ok = $false; summary = "The agent script failed: $($_.Exception.Message)" }
  }
  Show-Outcome $outcome $clock.Elapsed
  Send-Report $task $outcome
  Write-Host $rule -ForegroundColor DarkCyan
  Log 'yangi vazifa kutilmoqda...' DarkGray
}

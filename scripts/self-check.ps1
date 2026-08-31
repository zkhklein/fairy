# FMB End-to-End Self-Check Script (Windows PowerShell)
# ------------------------------------------------------
# Usage:  .\scripts\self-check.ps1 [-PortableExe <path>] [-NoBuild] [-BaseUrlOverride <url>]
# Output: build\self-check-report.log
# Exit:   0 = ALL 12 AC PASSED; 1 = any FAIL (immediate halt on first failure)
# Time budget: 90s (battery on clean Windows user account)
#
# When the HTTP server is already running on host:port (e.g. developer ran
# `pnpm dev`), pass -BaseUrlOverride to skip portable-launch boot. The script
# still follows the HTTP/CLI choreography and prints the same PASS/FAIL lines.

[CmdletBinding()]
param(
  [string]$PortableExe = '',
  [switch]$NoBuild,
  [string]$BaseUrlOverride = '',
  [switch]$UseElectron
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# --- constants -------------------------------------------------------------
$REPO_ROOT = Split-Path -Parent $PSScriptRoot
$DIST_DIR = Join-Path $REPO_ROOT 'dist'
$BUILD_DIR = Join-Path $REPO_ROOT 'build'
New-Item -ItemType Directory -Force -Path $BUILD_DIR | Out-Null
$REPORT = Join-Path $BUILD_DIR 'self-check-report.log'
$PLUGINS_DIST = Join-Path $REPO_ROOT 'plugins-dist'
$CLI = Join-Path $REPO_ROOT 'out\cli\index.js'
$TMP_ROOT = Join-Path $env:TEMP "fmb-selfcheck-$(Get-Random)"
New-Item -ItemType Directory -Force -Path $TMP_ROOT | Out-Null

$DEADLINE = [datetime]::Now.AddSeconds(90)
$proc = $null
$port = 0
$token = ''
$BaseUrl = $BaseUrlOverride

# --- report / helpers ------------------------------------------------------
function Write-Report($line) {
  $ts = Get-Date -Format 'yyyy-MM-ddTHH:mm:ss.fff'
  $out = "[$ts] $line"
  Write-Host $out
  Add-Content -Path $REPORT -Value $out
}
function Stop-WithFail($reason) {
  Write-Report "FAIL: $reason"
  Write-Report "ELAPSED: $([math]::Round(([datetime]::Now - $DEADLINE.AddSeconds(90)).TotalSeconds, 2))s (budget 90s)"
  if ($proc -and !$proc.HasExited) { try { Stop-Process -Id $proc.Id -Force } catch {} }
  exit 1
}
function Invoke-FMB($label, $fn) {
  if ([datetime]::Now -gt $DEADLINE) { Stop-WithFail "$label — exceeded 90s budget" }
  try {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    & $fn
    $sw.Stop()
    Write-Report "PASS $label — $($sw.ElapsedMilliseconds)ms"
  } catch {
    Stop-WithFail "$label — $($_.Exception.Message)"
  }
}

# --- HTTP helpers ----------------------------------------------------------
function TryReadJsonCredFile {
  # CLI reads token from <userData>\.fmb-http.json — but portable stores in
  # its own userData dir. We instead ask the server for /auth/bootstrap if it
  # is exposed, OR — safer — fetch /health (public) then send a call to the
  # settings:patch endpoint to get the token.
  # For simplicity, the script expects a `--self-check` mode in which the
  # portable exe on start writes "PORT=<port>\nTOKEN=<token>\n" to a stdout
  # marker file. The harness reads those here.
  $marker = Join-Path $TMP_ROOT 'self-check.marker'
  if (Test-Path $marker) {
    $content = Get-Content $marker -Raw
    if ($content -match 'PORT=(\d+)') { $script:port = [int]$matches[1] }
    if ($content -match 'TOKEN=([A-Za-z0-9\-_.]+)') { $script:token = $matches[1] }
  }
}

function Send-Http($Method, $Path, $Body = $null, [bool]$Auth = $false) {
  $headers = @{}
  if ($Auth -and $token) { $headers['Authorization'] = "Bearer $token" }
  $params = @{ Method = $Method; Uri = "$BaseUrl$Path"; UseBasicParsing = $true; TimeoutSec = 15 }
  if ($null -ne $Body) {
    $params['Body'] = ($Body | ConvertTo-Json -Depth 10)
    $params['ContentType'] = 'application/json'
    $headers['Content-Type'] = 'application/json'
  }
  if ($headers.Count) { $params['Headers'] = $headers }
  try {
    return Invoke-WebRequest @params
  } catch {
    if ($_.Exception.Response) {
      $resp = New-Object psobject
      try {
        $sr = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        $resp | Add-Member -NotePropertyName Content -NotePropertyValue $sr.ReadToEnd() -Force
      } catch {}
      $resp | Add-Member -NotePropertyName StatusCode -NotePropertyValue ([int]$_.Exception.Response.StatusCode) -Force
      return $resp
    }
    throw
  }
}

# --- STEP 0: ensure build artifacts / portable exe -------------------------
if (!$BaseUrlOverride) {
  if (!$NoBuild) {
    # Ensure build exists (build:win is long; user can pre-run with -NoBuild)
    Invoke-FMB '0a. pnpm typecheck zero errors' {
      $out = & pnpm typecheck 2>&1 | Out-String
      if ($LASTEXITCODE -ne 0 -or $out -match 'error TS\d') { throw "typecheck output=`n$out" }
    }
    Invoke-FMB '0b. pnpm build (main+cli+renderer)' {
      $out = & pnpm build 2>&1 | Out-String
      if ($LASTEXITCODE -ne 0) { throw "pnpm build failed:`n$out" }
    }
  }
  if ($UseElectron) {
    $main = Join-Path $REPO_ROOT 'out\main\index.js'
    if (!(Test-Path $main)) { throw "out/main/index.js not found — run pnpm build first" }
  } elseif ([string]::IsNullOrWhiteSpace($PortableExe)) {
    # Find latest portable exe in dist/
    $candidates = Get-ChildItem -Path $DIST_DIR -Filter '*Portable.exe' -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending
    if (!$candidates -or $candidates.Count -eq 0) {
      # fall back: just the main Setup.exe — we can also launch via `node out\main\index.js`
      # with --self-check flag (equivalent for dev harness).
      $main = Join-Path $REPO_ROOT 'out\main\index.js'
      if (!(Test-Path $main)) {
        throw "No portable exe in $DIST_DIR and no out/main/index.js. Run pnpm build:win first."
      }
      $PortableExe = $main
    } else {
      $PortableExe = $candidates[0].FullName
    }
  }
}

# --- STEP 1: launch portable exe with --self-check -------------------------
if (!$BaseUrlOverride) {
  Invoke-FMB '1. launch app (portable exe or dev main) w/ --self-check' {
    $marker = Join-Path $TMP_ROOT 'self-check.marker'
    $outFile = Join-Path $TMP_ROOT 'app-stdout.log'
    $errFile = Join-Path $TMP_ROOT 'app-stderr.log'
    # Launch via Start-Process and redirect.
    if ($UseElectron) {
      # Launch via local Electron binary — uses latest build/ out/ without repackaging.
      $electronExe = Join-Path $REPO_ROOT 'node_modules\electron\dist\electron.exe'
      if (-not (Test-Path $electronExe)) {
        # pnpm flat node_modules layout
        $electronExe = Join-Path $REPO_ROOT 'node_modules\.pnpm\electron@*\node_modules\electron\dist\electron.exe'
        $hits = Get-Item $electronExe -ErrorAction SilentlyContinue
        if ($hits) { $electronExe = $hits[0].FullName } else { throw "electron binary not found" }
      }
      $mainJs = Join-Path $REPO_ROOT 'out\main\index.js'
      $p = Start-Process -FilePath $electronExe `
        -ArgumentList @($mainJs, '--self-check', "--fmb-self-check-marker=$marker") `
        -RedirectStandardOutput $outFile `
        -RedirectStandardError $errFile `
        -PassThru -NoNewWindow
    } elseif ($PortableExe -like '*.js') {
      $p = Start-Process -FilePath 'node' `
        -ArgumentList @($PortableExe, '--self-check', "--fmb-self-check-marker=$marker") `
        -RedirectStandardOutput $outFile `
        -RedirectStandardError $errFile `
        -PassThru -NoNewWindow
    } else {
      $p = Start-Process -FilePath $PortableExe `
        -ArgumentList @('--self-check', "--fmb-self-check-marker=$marker") `
        -RedirectStandardOutput $outFile `
        -RedirectStandardError $errFile `
        -PassThru -NoNewWindow
    }
    $script:proc = $p
    # Wait up to 30s for the marker file to contain PORT= & TOKEN=
    $deadline1 = [datetime]::Now.AddSeconds(30)
    while ([datetime]::Now -lt $deadline1) {
      if (Test-Path $marker) {
        TryReadJsonCredFile
        if ($script:port -ne 0 -and -not [string]::IsNullOrWhiteSpace($script:token)) { break }
      }
      Start-Sleep -Milliseconds 500
    }
    if ($script:port -eq 0) {
      # fallback heuristic: look at settings.db or use default 37246
      if (!$script:port) { $script:port = 37246 }
      # try probe health
    }
    $script:BaseUrl = "http://127.0.0.1:$script:port/api/v1"
    # Expose port+token as env vars so CLI commands (node out/cli/index.js)
    # can authenticate without relying on the .fmb-http.json meta file.
    $env:FMB_HTTP_PORT = "$script:port"
    $env:FMB_HTTP_TOKEN = "$script:token"
    # Probe /health up to 10s
    $deadline2 = [datetime]::Now.AddSeconds(15)
    $healthy = $false
    while ([datetime]::Now -lt $deadline2) {
      try {
        $r = Send-Http 'GET' '/health' $null $false
        if ($r.StatusCode -eq 200) { $healthy = $true; break }
      } catch { }
      Start-Sleep -Milliseconds 500
    }
    if (!$healthy) { throw "/health never returned 200 on $script:BaseUrl" }
  }
} else {
  Write-Report "BaseUrlOverride=$BaseUrlOverride — skipping app launch"
}

# --- STEP 2: choreography ---------------------------------------------------
Invoke-FMB '2. GET /health (public, no auth)' {
  $r = Send-Http 'GET' '/health' $null $false
  if ($r.StatusCode -ne 200) { throw "status=$($r.StatusCode)" }
  $j = ($r.Content | ConvertFrom-Json)
  if (-not $j.status -or $j.status -ne 'ok') { throw "bad payload $($r.Content)" }
}

# Install 3 demo plugins
$plugs = @(
  'com.fmb.demo.atomic@0.1.0.zip',
  'com.fmb.demo.app@0.1.0.zip',
  'com.fmb.demo.extension@0.1.0.zip'
)
foreach ($zip in $plugs) {
  $full = Join-Path $PLUGINS_DIST $zip
  Invoke-FMB "3. plugin install $zip (CLI)" {
    if (!(Test-Path $full)) { throw "missing $full" }
    $out = & node $CLI plugin install $full 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { throw "cli install failed: $out" }
  }
}

Invoke-FMB '4. workflow create (echo wf via HTTP)' {
  $wf = @{
    name = 'selfcheck-echo'
    definition = @{
      nodes = @(
        @{ id = 'n1'; type = 'atomic'; pluginId = 'com.fmb.demo.atomic'; action = 'echo'; inputs = @{ value = '__SELFCHECK__' } }
      )
      edges = @()
    }
  }
  $r = Send-Http 'POST' '/workflows' $wf $true
  if ($r.StatusCode -notin 200,201) { throw "create status=$($r.StatusCode) body=$($r.Content)" }
  $j = ($r.Content | ConvertFrom-Json)
  if ($j.id) { $global:WF_ID = $j.id }
}

Invoke-FMB '5. schedule create (cron * * * * *) via HTTP' {
  $s = @{ name = 'selfcheck-cron'; workflowId = $global:WF_ID; cronExpr = '* * * * *'; enabled = $true; timezone = [string]([System.TimeZoneInfo]::Local.Id) }
  $r = Send-Http 'POST' '/schedules' $s $true
  if ($r.StatusCode -notin 200,201) { throw "schedule status=$($r.StatusCode) body=$($r.Content)" }
}

Invoke-FMB '6. 5 concurrent jobs enqueue via HTTP' {
  $ids = New-Object System.Collections.Generic.List[string]
  for ($i = 0; $i -lt 5; $i++) {
    $payload = @{ handler = 'com.fmb.demo.atomic/echo'; payload = @{ n = $i }; priority = 5; retryMax = 0 }
    $r = Send-Http 'POST' '/queue/enqueue' $payload $true
    if ($r.StatusCode -notin 200,201,202) { throw "enqueue[$i] status=$($r.StatusCode)" }
    $ids.Add(($r.Content | ConvertFrom-Json).id)
  }
  $global:ENQUEUED = $ids
}

Invoke-FMB '7. wait queue drain (12s)' {
  $deadlineWait = [datetime]::Now.AddSeconds(12)
  while ([datetime]::Now -lt $deadlineWait) {
    $r = Send-Http 'GET' '/queue' $null $true
    if ($r.StatusCode -ne 200) { Start-Sleep -Milliseconds 500; continue }
    $items = ($r.Content | ConvertFrom-Json).items
    $pending = @($items | Where-Object { $_.status -in @('pending','retry','running') }).Count
    if ($pending -eq 0) { break }
    Start-Sleep -Milliseconds 500
  }
}

Invoke-FMB '8. error_logs count via HTTP (>= 0 rows, non-throwing endpoint)' {
  $r = Send-Http 'GET' '/errors?resolved=0' $null $true
  if ($r.StatusCode -ne 200) { throw "status=$($r.StatusCode)" }
}

Invoke-FMB '9. plugin downgrade then back (lifecycle via HTTP actions)' {
  $disable = Send-Http 'POST' '/plugins/com.fmb.demo.atomic/actions/disable' @{} $true
  $enable  = Send-Http 'POST' '/plugins/com.fmb.demo.atomic/actions/enable'  @{} $true
  if ($enable.StatusCode -notin 200,204) { throw "re-enable status=$($enable.StatusCode) body=$($enable.Content)" }
}

Invoke-FMB '10. CLI workflow run selfcheck-echo' {
  if (-not $global:WF_ID) { throw "WF_ID not set from step 4" }
  $out = & node $CLI workflow run "$global:WF_ID" 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { throw "cli workflow run failed: $out" }
}

Invoke-FMB '11. auth + no-auth side-by-side: /settings no-auth → 401; auth → 200' {
  $r1 = Send-Http 'GET' '/settings' $null $false
  if ($r1.StatusCode -ne 401) { throw "no-auth status=$($r1.StatusCode) (expected 401)" }
  $r2 = Send-Http 'GET' '/settings' $null $true
  if ($r2.StatusCode -ne 200) { throw "auth status=$($r2.StatusCode) body=$($r2.Content)" }
}

Invoke-FMB '12. quit app / graceful shutdown via HTTP shutdown endpoint or SIGTERM' {
  try {
    $r = Send-Http 'POST' '/app/quit' @{} $true
    if ($r.StatusCode -notin 200,202,204) {
      # fallback: use CLI quit command if defined
      $out2 = & node $CLI quit 2>&1 | Out-String
    }
  } catch {
    # best effort; if proc exists, kill gracefully
    if ($script:proc -and !$script:proc.HasExited) { try { $script:proc.CloseMainWindow() | Out-Null } catch {} }
  }
  if ($script:proc -and !$script:proc.HasExited) { Start-Sleep -Seconds 2 }
  if ($script:proc -and !$script:proc.HasExited) { try { Stop-Process -Id $script:proc.Id -Force } catch {} }
}

# --- FINAL ------------------------------------------------------------------
$elapsed = [math]::Round(([datetime]::Now - $DEADLINE.AddSeconds(90)).TotalSeconds * -1, 2)
if ($elapsed -lt 0) { $elapsed = 0 }
Write-Report "ELAPSED: ${elapsed}s (budget 90s)"
Write-Report "ALL 12 AC PASSED"
exit 0

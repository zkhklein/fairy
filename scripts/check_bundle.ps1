Get-Content $env:PWD\electron-vite-build.log -Tail 15 -ErrorAction SilentlyContinue
Write-Host "--- SIZE ---"
if (Test-Path out\main\index.js) {
  $len = (Get-Item out\main\index.js).Length
  Write-Host ("main: {0:N0} KB" -f ($len/1KB))
} else {
  Write-Host "main MISSING"
  exit 2
}
Write-Host "--- external checks ---"
function CountMatch($pattern) {
  return (Select-String -Path out\main\index.js -Pattern $pattern -ErrorAction SilentlyContinue | Measure-Object).Count
}
Write-Host ("BETTER_SQLITE3 require(...): {0}" -f (CountMatch "require\(['\x22]better-sqlite3['\x22]\)"))
Write-Host ("KYSELY require(...): {0}" -f (CountMatch "require\(['\x22]kysely['\x22]\)"))
Write-Host ("NANOID require(...): {0}" -f (CountMatch "require\(['\x22]nanoid['\x22]\)"))
Write-Host ("PINO require(...): {0}" -f (CountMatch "require\(['\x22]pino['\x22]\)"))
$nodeStringCount = (CountMatch "better_sqlite3.node")
if ($nodeStringCount -gt 0) { Write-Host "BETTER_SQLITE3 .node BUNDLED: YES — BAD" } else { Write-Host "BETTER_SQLITE3 .node BUNDLED: NO — GOOD" }
Write-Host "--- modules transformed count ---"
if (Test-Path electron-vite-build.log) {
  $t = Select-String -Path electron-vite-build.log -Pattern "modules transformed" -ErrorAction SilentlyContinue
  foreach ($l in $t) { Write-Host $l.Line.Trim() }
}

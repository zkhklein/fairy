Param($File = 'build/main-app/index.mjs')
Write-Host "EXTERNAL IMPORTS/REQUIRES IN $File"
function Report($name) {
  $reqCount = (Select-String -Path $File -Pattern "require\(['\x22]$($name.replace('.','\.'))['\x22]\)").Count
  $impCount = (Select-String -Path $File -Pattern "from ['\x22]$($name.replace('.','\.'))['\x22]").Count
  $impBareCount = (Select-String -Path $File -Pattern "import ['\x22]$($name.replace('.','\.'))['\x22]").Count
  Write-Host ("  {0}: require={1}, import-from={2}, import-bare={3}" -f $name, $reqCount, $impCount, $impBareCount)
}
Report 'better-sqlite3'
Report 'kysely'
Report 'nanoid'
Report 'pino'
Report 'rotating-file-stream'
Report 'electron'
$bundledNative = (Select-String -Path $File -Pattern 'better_sqlite3.node' -SimpleMatch).Count
Write-Host ("  better_sqlite3.node string BUNDLED: {0} (expect 0 = external)" -f $bundledNative)

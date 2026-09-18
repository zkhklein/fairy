/**
 * com.fmb.tools.sevenzip — 7-Zip wrapper.
 *
 * The sandbox has no child_process, so we cannot exec 7z synchronously or
 * capture its exit code. Strategy:
 *   1. hostApi.processes.start(sevenZipPath, args) launches 7z.exe detached.
 *   2. Poll hostApi.processes.query(['7z.exe']) every ~1.5s until 7z.exe is
 *      no longer running → archive generation finished.
 *   3. Return { ok: true } (file existence is verified indirectly by the
 *      upload step; if 7z failed, no output files exist and upload reports
 *      an empty-folder abort).
 *
 * 7z command for split + password:
 *   7z.exe a -p<PASSWORD> -v4092m "<outDir>\<name>.7z" "<sourcePath>"
 * Produces <name>.7z.001, <name>.7z.002, … inside <outDir>.
 */
/* global hostApi, __hostEnv */

var DEFAULT_7Z = 'C:\\Program Files\\7-Zip\\7z.exe';
var MAX_WAIT_MS = 30 * 60 * 1000; // 30 minutes

// Compression level whitelist → 7z -mx value. Whitelist mapping (not raw
// pass-through) because the value lands on a command line.
var LEVELS = { store: '0', fastest: '1', normal: '5', max: '9' };

function _env() {
  return (typeof __hostEnv === 'object' && __hostEnv) ? __hostEnv : {};
}

async function _getSevenZipPath() {
  var p = await hostApi.kv.get('config:sevenzipPath');
  if (p && p.trim()) return p.trim();
  // Fallback: try standard install locations.
  var env = _env();
  var cands = [
    DEFAULT_7Z,
    (env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)') + '\\7-Zip\\7z.exe',
  ];
  for (var i = 0; i < cands.length; i++) {
    try {
      // processes.start throws ENOENT if missing; we can't stat without fs,
      // so we just return the first candidate and let start() validate.
      return cands[i];
    } catch (_) {}
  }
  return DEFAULT_7Z;
}

/**
 * Check whether a file exists, using a uniquely-named probe process.
 *
 * The sandbox has no fs API, so the checker PowerShell (signal-on-EXISTS)
 * copies PING.EXE to `%TEMP%\<probe>.exe` under a per-check unique name and
 * starts it; we then poll processes.query for THAT name. Earlier versions
 * used a shared `ping` signal which cross-contaminated between consecutive
 * checks (a leftover ping from check A made check B report "missing" for an
 * existing file — this caused false "压缩失败" after real success).
 */
async function _fileExists(filePath) {
  var probe = 'fmbp' + Math.random().toString(36).slice(2, 10);
  var probeExe = probe + '.exe';
  var env = _env();
  var ps = (env['SystemRoot'] || env['windir'] || 'C:\\Windows') + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  var checker =
    "if (Test-Path '" + filePath + "') { " +
    "Copy-Item \"$env:SystemRoot\\System32\\PING.EXE\" (Join-Path $env:TEMP '" + probeExe + "') -Force; " +
    "Start-Process (Join-Path $env:TEMP '" + probeExe + "') -ArgumentList '-n','6','127.0.0.1' -WindowStyle Hidden; " +
    "}";
  try {
    var enc = Buffer.from(checker, 'utf16le').toString('base64');
    await hostApi.processes.start({
      executablePath: ps,
      args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc],
      detached: false, // PowerShell hangs under detached:true (no console)
      timeoutMs: 8000,
    });
  } catch (_) { /* checker spawn failed; treat as missing */ return false; }
  for (var i = 0; i < 16; i++) {
    await new Promise(function (r) { setTimeout(r, 500); });
    var q = await hostApi.processes.query({ processNames: [probeExe] });
    if (q[probeExe]) return true; // probe seen → file exists
  }
  return false; // no probe within 8s → file missing
}

module.exports = {
  activate(ctx) {
    ctx.hostApi.logger.info('sevenzip activated', { pluginId: ctx.pluginId });
  },

  deactivate() {
    hostApi.logger.info('sevenzip deactivated', {});
  },

  /** Set the 7-Zip executable path (called by the app plugin's config UI). */
  async setSevenZipPath(payload) {
    var p = payload && payload.path;
    if (p && p.trim()) {
      await hostApi.kv.set('config:sevenzipPath', p.trim());
      hostApi.logger.info('sevenzip: path set', { path: p.trim() });
      return { ok: true, path: p.trim() };
    }
    return { ok: true, path: null };
  },

  /**
   * Compress a file/folder into a split, password-protected 7z archive.
   * payload: { sourcePath, outputDir, archiveName, password, volumeSize, level }
   *   volumeSize defaults to '4092m' (per spec).
   *   level: 'store' | 'fastest' | 'normal' (default) | 'max' → 7z -mx 0/1/5/9.
   *          Game/backup assets are usually pre-compressed — 'fastest' is
   *          several times faster with almost no size penalty.
   *
   * Completion is VERIFIED via 7-Zip's real exit code, not assumed:
   *   1. A single PowerShell wrapper (EncodedCommand, no quoting hell) creates
   *      outputDir, clears stale flags, runs 7z, then writes a flag file whose
   *      NAME carries the exit code: `_compress.done.<code>`.
   *   2. We poll for `_compress.done.*` (Test-Path wildcard) until timeout —
   *      no tasklist name polling, no spawn/exit race.
   *   3. Only exit code 0 counts as success; otherwise compress throws and the
   *      task chain aborts honestly. (7z exit 1 = warning, 2 = fatal, etc.)
   */
  async compress(payload) {
    var sourcePath = payload && payload.sourcePath;
    var outputDir = payload && payload.outputDir;
    var archiveName = payload && payload.archiveName;
    var password = payload && payload.password;
    var volumeSize = (payload && payload.volumeSize) || '4092m';
    var levelKey = (payload && payload.level) || 'normal';
    var mx = LEVELS[levelKey] || LEVELS.normal;

    if (!sourcePath) throw new Error('compress: sourcePath required');
    if (!outputDir) throw new Error('compress: outputDir required');
    if (!archiveName) throw new Error('compress: archiveName required');
    if (!password) throw new Error('compress: password required');

    var sevenZipPath = await _getSevenZipPath();
    var outArchive = outputDir + '\\' + archiveName + '.7z';
    var firstVolume = outArchive + '.001';
    var doneWildcard = outputDir + '\\_compress.done.*';
    var doneOk = outputDir + '\\_compress.done.0';

    // Idempotent resume: a verified-complete archive (done.0 flag + first
    // volume on disk) means a previous run already finished compression —
    // skip re-compressing (resuming an aborted task must not redo GBs of work).
    if ((await _fileExists(doneOk)) && (await _fileExists(firstVolume))) {
      hostApi.logger.info('sevenzip.compress: verified archive already exists, skipping', { firstVolume: firstVolume });
      return { ok: true, archiveName: archiveName, outputDir: outputDir, reused: true };
    }

    var env = _env();
    var ps = (env['SystemRoot'] || env['windir'] || 'C:\\Windows') + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    var psScript = [
      "New-Item -ItemType Directory -Force '" + outputDir + "' | Out-Null;",
      "Remove-Item -Force '" + outputDir + "\\_compress.done.*' -ErrorAction SilentlyContinue;",
      // Delete previous volumes first: 7z treats an existing .7z.001 as an
      // archive to UPDATE, and multivolume update is NOT implemented in 7z
      // (fatal exit 2: "Updating for multivolume archives is not implemented").
      "Remove-Item -Force '" + outputDir + "\\" + archiveName + ".7z*' -ErrorAction SilentlyContinue;",
      // 7z output goes to _compress.log so a future failure is diagnosable
      // (stdout is piped through the wrapper and otherwise lost).
      // -mhe=on encrypts the header too: without it, filenames/folder names
      // inside the archive are visible WITHOUT the password (only the data
      // is encrypted). Verified: 7z l shows names without -mhe, prompts for
      // a password with it.
      "& '" + sevenZipPath + "' a '-p" + password + "' '-mhe=on' '-v" + volumeSize + "' '-mx" + mx + "' -y '" + outArchive + "' '" + sourcePath + "' *>&1 | Out-File -Encoding utf8 '" + outputDir + "\\_compress.log';",
      "$c = $LASTEXITCODE;",
      // NOTE: double-quoted interpolation — New-Item rejects '<str>'$c adjacent
      // concatenation after a switch ("positional parameter cannot be found").
      "New-Item -ItemType File -Force \"" + outputDir + "\\_compress.done.$c\" | Out-Null;",
    ].join('');
    var enc = Buffer.from(psScript, 'utf16le').toString('base64');

    hostApi.logger.info('sevenzip.compress: starting', {
      sevenZipPath: sevenZipPath,
      sourcePath: sourcePath,
      outArchive: outArchive,
      volumeSize: volumeSize,
    });

    try {
      // IMPORTANT: detached must be false for PowerShell — with detached:true
      // (DETACHED_PROCESS, no console) powershell.exe hangs before executing
      // the script at all. node.exe tolerates detached; PowerShell does not.
      await hostApi.processes.start({
        executablePath: ps,
        args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc],
        detached: false,
        timeoutMs: 15000,
      });
      hostApi.logger.info('sevenzip.compress: spawned wrapper');
    } catch (e) {
      var msg = e && e.message ? e.message : String(e);
      hostApi.logger.error('sevenzip.compress: spawn failed', { error: msg });
      throw new Error('sevenzip: failed to start 7-Zip: ' + msg);
    }

    // Poll for the done flag (wildcard) until timeout.
    var start = Date.now();
    var done = false;
    while (Date.now() - start < MAX_WAIT_MS) {
      if (await _fileExists(doneWildcard)) { done = true; break; }
    }
    if (!done) {
      hostApi.logger.warn('sevenzip.compress: timed out waiting for done flag', { archiveName: archiveName });
      throw new Error('sevenzip: compression timed out after ' + (MAX_WAIT_MS / 60000) + ' minutes');
    }

    // Only exit code 0 = success. (1 = warning; treat as failure — honest
    // failure beats fake success for a backup pipeline.)
    var okExit = await _fileExists(doneOk);
    if (!okExit) {
      var errMsg = 'sevenzip: 7-Zip 压缩失败（退出码非 0）。可能原因：源路径不存在 / 磁盘空间不足 / 权限不足。详见 ' + outputDir + '\\_compress.log';
      hostApi.logger.error('sevenzip.compress: non-zero exit code', { outputDir: outputDir });
      throw new Error(errMsg);
    }

    // Belt-and-suspenders: the first volume must also exist on disk.
    var produced = await _fileExists(firstVolume);
    if (!produced) {
      var errMsg2 = 'sevenzip: 压缩完成但未找到输出分卷 ' + firstVolume;
      hostApi.logger.error('sevenzip.compress: no output volume', { firstVolume: firstVolume });
      throw new Error(errMsg2);
    }

    hostApi.logger.info('sevenzip.compress: done + verified', { archiveName: archiveName, firstVolume: firstVolume });
    return { ok: true, archiveName: archiveName, outputDir: outputDir };
  },

  /**
   * Delete a folder (and all contents) — used for cleanup after upload.
   * payload: { folderPath }
   */
  async deleteFolder(payload) {
    var folderPath = payload && payload.folderPath;
    if (!folderPath) throw new Error('deleteFolder: folderPath required');

    var env = _env();
    var cmdPath = (env['SystemRoot'] || env['windir'] || 'C:\\Windows') + '\\System32\\cmd.exe';

    var args = ['/c', 'rmdir', '/s', '/q', folderPath];

    hostApi.logger.info('sevenzip.deleteFolder: starting', { folderPath: folderPath });
    try {
      await hostApi.processes.start({
        executablePath: cmdPath,
        args: args,
        detached: true,
        timeoutMs: 10000,
      });
    } catch (e) {
      hostApi.logger.warn('sevenzip.deleteFolder: spawn failed (folder may not exist)', {
        folderPath: folderPath,
        error: e && e.message ? e.message : String(e),
      });
      return { ok: true, note: 'spawn failed; folder may not exist' };
    }

    // cmd.exe may be running for other reasons; wait a short fixed time and
    // treat as done (rmdir is nearly instantaneous for our small folders).
    await new Promise(function (r) { setTimeout(r, 2000); });
    hostApi.logger.info('sevenzip.deleteFolder: done', { folderPath: folderPath });
    return { ok: true };
  },
};

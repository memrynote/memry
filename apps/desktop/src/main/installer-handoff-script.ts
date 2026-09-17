// Pure. No imports: Node strips the types of this file at runtime for
// scripts/installer-handoff-script.mjs, so it must stay free of runtime
// dependencies and of non-erasable syntax (enum, namespace, parameter properties).

export const VELOPACK_SETUP_ASSET_NAME = 'MemryNote-win-Setup.exe'
export const INSTALLER_HANDOFF_SIGNER_SUBJECT = 'CN=Open Source Developer Kaan Karaca'
export const GITHUB_RELEASE_DOWNLOAD_BASE = 'https://github.com/memrynote/memry/releases/download'

/** Everything the detached script needs. Absolute Windows paths, already resolved by the caller. */
export interface InstallerHandoffPlan {
  appPid: number
  /** 'Memrynote.exe' */
  appExeName: string
  /** dirname(process.execPath), which is the NSIS $INSTDIR. */
  installDir: string
  /** installDir\Uninstall MemryNote.exe */
  uninstallerPath: string
  /** <tmp>\memry-installer-handoff-<pid>; the uninstaller copy lives here. */
  workDir: string
  /** <userData>\installer-handoff\MemryNote-win-Setup.exe */
  setupExePath: string
  /** <userData>\logs\velopack-setup.log */
  setupLogPath: string
  /**
   * <userData>\logs\installer-handoff.log. The script's own transcript. Velopack's
   * --log only exists once Setup.exe runs, so a hand-off that died before that left
   * no trace at all; this one records every step and its exit code.
   */
  handoffLogPath: string
  /**
   * electron-updater's already-downloaded NSIS setup.exe; the safety net if
   * Setup.exe leaves no app behind. null from the CLI.
   */
  nsisInstallerPath: string | null
}

export type AuthenticodeVerdict = { ok: true; subject: string } | { ok: false; reason: string }

/**
 * `ping -n 2 127.0.0.1` is the sleep: `timeout /t` aborts with "Input redirection
 * is not supported" when stdin is not a console, which it is not under
 * `stdio: 'ignore'`. `tasklist` is filtered by PID and image name so a recycled
 * PID cannot match. The uninstaller runs from a copy with `_?=` (last argument,
 * unquoted, the form electron-builder's own installUtil.nsh uses) so it blocks
 * and `RMDir /r $INSTDIR` can remove the original; no `--updated`, so the
 * tolerant removal path runs. Uninstall before Setup: the NSIS uninstaller
 * deletes the Start-menu and desktop `MemryNote.lnk`, the same paths Velopack
 * creates. Setup.exe launches the app itself.
 *
 * Every step logs its exit code and every failure routes to the NSIS fallback
 * instead of running on. The previous version checked nothing, logged nothing of
 * its own, and deleted itself on the way out, so a failed migration was
 * indistinguishable from one that never started: telemetry shows nine Windows
 * users stuck on 2026.912.1 and not one `handoff-applied` outcome, with no
 * evidence anywhere on disk explaining which step gave up.
 */
export function renderInstallerHandoffScript(plan: InstallerHandoffPlan): string {
  const lines = [
    '@echo off',
    'setlocal',
    'rem MemryNote installer hand-off: wait for the app to exit, remove the NSIS install, install the Velopack build.',
    `set "APP_PID=${plan.appPid}"`,
    `set "APP_EXE=${plan.appExeName}"`,
    `set "INSTALL_DIR=${plan.installDir}"`,
    `set "UNINSTALLER=${plan.uninstallerPath}"`,
    `set "WORK_DIR=${plan.workDir}"`,
    `set "SETUP=${plan.setupExePath}"`,
    `set "SETUP_LOG=${plan.setupLogPath}"`,
    `set "HANDOFF_LOG=${plan.handoffLogPath}"`,
    `set "NSIS_INSTALLER=${plan.nsisInstallerPath ?? ''}"`,
    'set "VELOPACK_EXE=%LocalAppData%\\MemryNote\\current\\Memrynote.exe"',
    '',
    'call :log "handoff start pid=%APP_PID% dir=%INSTALL_DIR%"',
    '',
    ':wait_for_exit',
    'tasklist /FI "PID eq %APP_PID%" /FI "IMAGENAME eq %APP_EXE%" /NH 2>nul | find /I "%APP_EXE%" >nul',
    'if not errorlevel 1 (',
    '  ping -n 2 127.0.0.1 >nul',
    '  goto wait_for_exit',
    ')',
    'call :log "app exited"',
    '',
    'if not exist "%WORK_DIR%" mkdir "%WORK_DIR%"',
    'copy /y "%UNINSTALLER%" "%WORK_DIR%\\Uninstall MemryNote.exe" >nul',
    'if errorlevel 1 (',
    '  call :log "copy-uninstaller failed"',
    '  goto fallback',
    ')',
    '',
    'start "" /wait "%WORK_DIR%\\Uninstall MemryNote.exe" /S _?=%INSTALL_DIR%',
    'call :log "uninstall exit=%errorlevel%"',
    '',
    'start "" /wait "%SETUP%" --silent --verbose --log "%SETUP_LOG%"',
    'call :log "setup exit=%errorlevel%"',
    '',
    'if exist "%VELOPACK_EXE%" (',
    '  call :log "result=velopack"',
    '  goto cleanup',
    ')',
    '',
    ':fallback',
    'call :log "velopack exe missing; falling back to nsis"',
    'if not exist "%NSIS_INSTALLER%" (',
    '  call :log "result=failed no-nsis-fallback"',
    '  goto cleanup',
    ')',
    'start "" /wait "%NSIS_INSTALLER%" /S --force-run',
    'call :log "result=nsis exit=%errorlevel%"',
    '',
    ':cleanup',
    'del /q "%SETUP%" >nul 2>&1',
    'rmdir /s /q "%WORK_DIR%" >nul 2>&1',
    'call :log "handoff done"',
    '(goto) 2>nul & del "%~f0"',
    '',
    ':log',
    'echo %DATE% %TIME% %~1>>"%HANDOFF_LOG%"',
    'exit /b 0'
  ]
  return `${lines.join('\r\n')}\r\n`
}

/**
 * The electron-updater payload this reads from. `files[].url` is typed `string` by
 * electron-updater itself; `tag` is added at runtime by its GitHub provider, so it
 * is declared optional here rather than probed for at runtime.
 */
export interface ReleaseTagSource {
  tag?: string
  files?: ReadonlyArray<{ url?: string }>
}

/** GitHub's `update-downloaded` payload carries `tag`; `files[].url` is the fallback when it is absolute. */
export function resolveReleaseTag(info: ReleaseTagSource): string | null {
  if (info.tag) return info.tag
  for (const file of info.files ?? []) {
    if (!file.url) continue
    const match = /\/releases\/download\/([^/]+)\//.exec(file.url)
    if (match) return match[1]
  }
  return null
}

export function velopackSetupUrl(tag: string): string {
  return `${GITHUB_RELEASE_DOWNLOAD_BASE}/${encodeURIComponent(tag)}/${VELOPACK_SETUP_ASSET_NAME}`
}

/**
 * Shape of `Get-AuthenticodeSignature | ConvertTo-Json -Compress`. Every field is
 * optional: the PowerShell host omits `StatusMessage` on some versions and sets
 * `SignerCertificate` to null for an unsigned file. `Status` is the numeric enum
 * value or its name depending on the host, hence the union.
 */
interface AuthenticodeSignatureJson {
  Status?: number | string
  StatusMessage?: string
  SignerCertificate?: { Subject?: string } | null
}

/** Parses `Get-AuthenticodeSignature | ConvertTo-Json -Compress` output. Valid == Status 0 or 'Valid'. */
export function judgeAuthenticode(stdout: string, expectedSubject: string): AuthenticodeVerdict {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return { ok: false, reason: 'signature output is not JSON' }
  }
  // Brand check rather than a truthiness/shape probe: it admits only a plain
  // object, so an array or a bare scalar is rejected here instead of silently
  // reading `undefined` fields off it further down.
  if (Object.prototype.toString.call(parsed) !== '[object Object]') {
    return { ok: false, reason: 'signature output is not an object' }
  }
  // SAFETY: the brand check above establishes a plain object, and every field of
  // AuthenticodeSignatureJson is optional and checked before use, so the assertion
  // grants no trust that the checks below do not re-establish.
  const report = parsed as AuthenticodeSignatureJson
  const status = report.Status
  if (status !== 0 && status !== 'Valid') {
    const message = report.StatusMessage ? ` (${report.StatusMessage})` : ''
    return { ok: false, reason: `signature status ${status ?? 'unknown'}${message}` }
  }
  const subject = report.SignerCertificate?.Subject
  if (!subject || !subject.includes(expectedSubject)) {
    return { ok: false, reason: `unexpected signer ${subject ?? 'none'}` }
  }
  return { ok: true, subject }
}

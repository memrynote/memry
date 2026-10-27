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
 * How the app spawns the script. `detached` is required: a non-detached child sits in
 * libuv's kill-on-close job object and dies with the app, which is the moment the script
 * starts its wait. The price is DETACHED_PROCESS, so the cmd.exe running the script has
 * no console, and any console program it starts without one of its own misbehaves:
 * `tasklist | find` hung forever (find never saw EOF) and a redirected `tasklist` printed
 * nothing, so the script either never left its wait or left it at once. Every command the
 * script runs must therefore be a cmd builtin, a GUI program, or powershell.exe, which
 * allocates its own console. `scripts/installer-handoff-script.mjs --spawn` spawns with
 * these exact options in the Windows smoke workflow.
 */
export const HANDOFF_SPAWN_OPTIONS = {
  detached: true,
  stdio: 'ignore',
  windowsHide: true
} as const

/**
 * The wait is `Process.WaitForExit` in powershell.exe (the app already shells out to it to
 * verify the signature), for a process matching both the PID and the image name so a
 * recycled PID cannot match. It exits 0 once the app is gone, at once when it already is
 * (a `Wait-Process` pipeline would exit 1 on the silenced Get-Process error), and 1 after
 * five minutes; a non-zero exit (timeout, or powershell unavailable) goes to the NSIS
 * fallback like every other failure. The
 * uninstaller runs from a copy with `_?=` (last argument, unquoted, the form
 * electron-builder's own installUtil.nsh uses) so it blocks and `RMDir /r $INSTDIR` can
 * remove the original; no `--updated`, so the tolerant removal path runs. Uninstall before
 * Setup: the NSIS uninstaller deletes the Start-menu and desktop `MemryNote.lnk`, the same
 * paths Velopack creates. `Setup.exe --silent` does not start the app (velopack
 * commands/install.rs: `if !dialogs::get_silent() { start_package }`), so the script starts it,
 * the way the NSIS fallback's `--force-run` does.
 *
 * Every step logs its exit code and every failure routes to the NSIS fallback
 * instead of running on. The previous version checked nothing, logged nothing of
 * its own, and deleted itself on the way out, so a failed migration was
 * indistinguishable from one that never started: telemetry shows nine Windows
 * users stuck on 2026.912.1 and not one `handoff-applied` outcome, with no
 * evidence anywhere on disk explaining which step gave up. The log line is
 * parenthesised because `exit=0>>file` is a redirect of handle 0 and swallows the digit.
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
    "powershell -NoProfile -NonInteractive -Command \"$p = Get-Process -Id %APP_PID% -ErrorAction SilentlyContinue; if ($p -and ($p.ProcessName + '.exe') -ieq '%APP_EXE%' -and -not $p.WaitForExit(300000)) { exit 1 }; exit 0\" >nul 2>&1",
    'if errorlevel 1 (',
    '  call :log "wait-for-exit failed"',
    '  goto fallback',
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
    '  start "" /d "%LocalAppData%\\MemryNote\\current" "%VELOPACK_EXE%"',
    '  call :log "relaunch exit=%errorlevel%"',
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
    '(echo %DATE% %TIME% %~1)>>"%HANDOFF_LOG%"',
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
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON from PowerShell Get-AuthenticodeSignature; every field is read defensively
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

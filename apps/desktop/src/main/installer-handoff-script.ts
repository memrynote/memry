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
 * unquoted) so it blocks and `RMDir /r $INSTDIR` can remove the original; no
 * `--updated`, so the tolerant removal path runs. Uninstall before Setup: the
 * NSIS uninstaller deletes the Start-menu and desktop `MemryNote.lnk`, the same
 * paths Velopack creates. Setup.exe launches the app itself.
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
    `set "NSIS_INSTALLER=${plan.nsisInstallerPath ?? ''}"`,
    'set "VELOPACK_EXE=%LocalAppData%\\MemryNote\\current\\Memrynote.exe"',
    '',
    ':wait_for_exit',
    'tasklist /FI "PID eq %APP_PID%" /FI "IMAGENAME eq %APP_EXE%" /NH 2>nul | find /I "%APP_EXE%" >nul',
    'if not errorlevel 1 (',
    '  ping -n 2 127.0.0.1 >nul',
    '  goto wait_for_exit',
    ')',
    '',
    'if not exist "%WORK_DIR%" mkdir "%WORK_DIR%"',
    'copy /y "%UNINSTALLER%" "%WORK_DIR%\\Uninstall MemryNote.exe" >nul',
    'start "" /wait "%WORK_DIR%\\Uninstall MemryNote.exe" /S _?=%INSTALL_DIR%',
    '',
    'start "" /wait "%SETUP%" --silent --verbose --log "%SETUP_LOG%"',
    '',
    'if not exist "%VELOPACK_EXE%" (',
    '  if exist "%NSIS_INSTALLER%" start "" /wait "%NSIS_INSTALLER%" /S --force-run',
    ')',
    '',
    'del /q "%SETUP%" >nul 2>&1',
    'rmdir /s /q "%WORK_DIR%" >nul 2>&1',
    '(goto) 2>nul & del "%~f0"'
  ]
  return `${lines.join('\r\n')}\r\n`
}

/** GitHub's `update-downloaded` payload carries `tag`; `files[].url` is the fallback when it is absolute. */
export function resolveReleaseTag(info: {
  tag?: unknown
  files?: ReadonlyArray<{ url?: unknown }>
}): string | null {
  if (typeof info.tag === 'string' && info.tag) return info.tag
  for (const file of info.files ?? []) {
    if (typeof file.url !== 'string') continue
    const match = /\/releases\/download\/([^/]+)\//.exec(file.url)
    if (match) return match[1]
  }
  return null
}

export function velopackSetupUrl(tag: string): string {
  return `${GITHUB_RELEASE_DOWNLOAD_BASE}/${encodeURIComponent(tag)}/${VELOPACK_SETUP_ASSET_NAME}`
}

/** Parses `Get-AuthenticodeSignature | ConvertTo-Json -Compress` output. Valid == Status 0 or 'Valid'. */
export function judgeAuthenticode(stdout: string, expectedSubject: string): AuthenticodeVerdict {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return { ok: false, reason: 'signature output is not JSON' }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, reason: 'signature output is not an object' }
  }
  const { Status, StatusMessage, SignerCertificate } = parsed as {
    Status?: unknown
    StatusMessage?: unknown
    SignerCertificate?: { Subject?: unknown } | null
  }
  if (Status !== 0 && Status !== 'Valid') {
    const status = typeof Status === 'string' || typeof Status === 'number' ? Status : 'unknown'
    const message = typeof StatusMessage === 'string' && StatusMessage ? ` (${StatusMessage})` : ''
    return { ok: false, reason: `signature status ${status}${message}` }
  }
  const subject = SignerCertificate?.Subject
  if (typeof subject !== 'string' || !subject.includes(expectedSubject)) {
    return {
      ok: false,
      reason: `unexpected signer ${typeof subject === 'string' ? subject : 'none'}`
    }
  }
  return { ok: true, subject }
}

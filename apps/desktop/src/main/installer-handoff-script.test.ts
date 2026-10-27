import { describe, expect, it } from 'vitest'
import {
  HANDOFF_SPAWN_OPTIONS,
  judgeAuthenticode,
  renderInstallerHandoffScript,
  resolveReleaseTag,
  velopackSetupUrl,
  type InstallerHandoffPlan
} from './installer-handoff-script'

const plan: InstallerHandoffPlan = {
  appPid: 1234,
  appExeName: 'Memrynote.exe',
  installDir: String.raw`C:\Users\kaan\AppData\Local\Programs\MemryNote`,
  uninstallerPath: String.raw`C:\Users\kaan\AppData\Local\Programs\MemryNote\Uninstall MemryNote.exe`,
  workDir: String.raw`C:\Users\kaan\AppData\Local\Temp\memry-installer-handoff-1234`,
  setupExePath: String.raw`C:\Users\kaan\AppData\Roaming\memrynote\installer-handoff\MemryNote-win-Setup.exe`,
  setupLogPath: String.raw`C:\Users\kaan\AppData\Roaming\memrynote\logs\velopack-setup.log`,
  handoffLogPath: String.raw`C:\Users\kaan\AppData\Roaming\memrynote\logs\installer-handoff.log`,
  nsisInstallerPath: String.raw`C:\Users\kaan\AppData\Local\memrynote-updater\pending\MemryNote-2026.911.1-setup.exe`
}

const scriptLines = (nsisInstaller: string): string[] => [
  '@echo off',
  'setlocal',
  'rem MemryNote installer hand-off: wait for the app to exit, remove the NSIS install, install the Velopack build.',
  'set "APP_PID=1234"',
  'set "APP_EXE=Memrynote.exe"',
  String.raw`set "INSTALL_DIR=C:\Users\kaan\AppData\Local\Programs\MemryNote"`,
  String.raw`set "UNINSTALLER=C:\Users\kaan\AppData\Local\Programs\MemryNote\Uninstall MemryNote.exe"`,
  String.raw`set "WORK_DIR=C:\Users\kaan\AppData\Local\Temp\memry-installer-handoff-1234"`,
  String.raw`set "SETUP=C:\Users\kaan\AppData\Roaming\memrynote\installer-handoff\MemryNote-win-Setup.exe"`,
  String.raw`set "SETUP_LOG=C:\Users\kaan\AppData\Roaming\memrynote\logs\velopack-setup.log"`,
  String.raw`set "HANDOFF_LOG=C:\Users\kaan\AppData\Roaming\memrynote\logs\installer-handoff.log"`,
  `set "NSIS_INSTALLER=${nsisInstaller}"`,
  String.raw`set "VELOPACK_EXE=%LocalAppData%\MemryNote\current\Memrynote.exe"`,
  '',
  'call :log "handoff start pid=%APP_PID% dir=%INSTALL_DIR%"',
  '',
  "powershell -NoProfile -NonInteractive -Command \"Get-Process -Id %APP_PID% -ErrorAction SilentlyContinue | Where-Object { ($_.ProcessName + '.exe') -ieq '%APP_EXE%' } | Wait-Process -Timeout 300\" >nul 2>&1",
  'if errorlevel 1 (',
  '  call :log "wait-for-exit failed"',
  '  goto fallback',
  ')',
  'call :log "app exited"',
  '',
  'if not exist "%WORK_DIR%" mkdir "%WORK_DIR%"',
  String.raw`copy /y "%UNINSTALLER%" "%WORK_DIR%\Uninstall MemryNote.exe" >nul`,
  'if errorlevel 1 (',
  '  call :log "copy-uninstaller failed"',
  '  goto fallback',
  ')',
  '',
  String.raw`start "" /wait "%WORK_DIR%\Uninstall MemryNote.exe" /S _?=%INSTALL_DIR%`,
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
  '(echo %DATE% %TIME% %~1)>>"%HANDOFF_LOG%"',
  'exit /b 0'
]

describe('renderInstallerHandoffScript', () => {
  it('renders the pinned batch script with CRLF line endings', () => {
    const script = renderInstallerHandoffScript(plan)

    expect(script).toBe(
      `${scriptLines(String.raw`C:\Users\kaan\AppData\Local\memrynote-updater\pending\MemryNote-2026.911.1-setup.exe`).join('\r\n')}\r\n`
    )
    expect(script.split('\r\n').join('')).not.toContain('\n')
  })

  it('leaves the NSIS fallback empty when no NSIS installer is on disk', () => {
    const script = renderInstallerHandoffScript({ ...plan, nsisInstallerPath: null })

    expect(script).toBe(`${scriptLines('').join('\r\n')}\r\n`)
    expect(script).toContain('set "NSIS_INSTALLER="\r\n')
  })

  // The previous script checked no exit code and wrote no log of its own, so a
  // migration that died before Setup.exe ran left nothing on disk to explain it.
  it('records every step and its exit code in its own log', () => {
    const lines = renderInstallerHandoffScript(plan).split('\r\n')

    expect(lines).toContain('call :log "app exited"')
    expect(lines).toContain('call :log "uninstall exit=%errorlevel%"')
    expect(lines).toContain('call :log "setup exit=%errorlevel%"')
    expect(lines).toContain('call :log "handoff done"')
    // The transcript survives the script deleting itself.
    expect(lines).toContain('(echo %DATE% %TIME% %~1)>>"%HANDOFF_LOG%"')
  })

  // `echo ...exit=0>>file` parses the 0 as a redirected handle, so every exit code the log
  // exists to record was written without its digit.
  it('parenthesises the log echo so a trailing exit code is not a redirect handle', () => {
    const logLine = renderInstallerHandoffScript(plan)
      .split('\r\n')
      .find((line) => line.includes('>>"%HANDOFF_LOG%"'))

    expect(logLine?.startsWith('(echo ')).toBe(true)
    expect(logLine?.includes(')>>"%HANDOFF_LOG%"')).toBe(true)
  })

  // The script runs in a console-less cmd.exe (HANDOFF_SPAWN_OPTIONS is detached). A console
  // program started there without a console of its own breaks: `tasklist | find` hung forever on
  // Windows 11 ARM64 and on windows-2022. Only cmd builtins, GUI programs and powershell.exe are
  // safe, and the windows-smoke workflow runs the script with the real spawn options.
  it('runs no console program other than powershell, which allocates its own console', () => {
    const builtinsAndGui = new Set([
      '@echo',
      'setlocal',
      'rem',
      'set',
      'call',
      'if',
      'goto',
      'mkdir',
      'copy',
      'start',
      'del',
      'rmdir',
      'exit',
      '(goto)',
      '(echo',
      'powershell',
      ')'
    ])
    const commands = renderInstallerHandoffScript(plan)
      .split('\r\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith(':'))
      .map((line) => line.split(/\s+/)[0].toLowerCase())

    expect(commands.filter((command) => !builtinsAndGui.has(command))).toEqual([])
    expect(HANDOFF_SPAWN_OPTIONS).toEqual({ detached: true, stdio: 'ignore', windowsHide: true })
  })

  it('goes to the NSIS fallback when the wait for the app fails', () => {
    const lines = renderInstallerHandoffScript(plan).split('\r\n')
    const waitAt = lines.findIndex((line) => line.startsWith('powershell '))

    expect(lines[waitAt]).toContain('Wait-Process -Timeout 300')
    expect(lines.slice(waitAt + 1, waitAt + 5)).toEqual([
      'if errorlevel 1 (',
      '  call :log "wait-for-exit failed"',
      '  goto fallback',
      ')'
    ])
  })

  it('routes a failed uninstaller copy to the NSIS fallback instead of running on', () => {
    const lines = renderInstallerHandoffScript(plan).split('\r\n')
    const copyAt = lines.indexOf(
      String.raw`copy /y "%UNINSTALLER%" "%WORK_DIR%\Uninstall MemryNote.exe" >nul`
    )

    expect(lines[copyAt + 1]).toBe('if errorlevel 1 (')
    expect(lines[copyAt + 3]).toBe('  goto fallback')
    expect(lines).toContain(':fallback')
    // Reaching the fallback with nothing to run must still be recorded, not silent.
    expect(lines).toContain('  call :log "result=failed no-nsis-fallback"')
  })

  it('skips the fallback once the Velopack install is present', () => {
    const lines = renderInstallerHandoffScript(plan).split('\r\n')
    const guardAt = lines.indexOf('if exist "%VELOPACK_EXE%" (')

    expect(lines[guardAt + 1]).toBe('  call :log "result=velopack"')
    expect(lines[guardAt + 2]).toBe('  goto cleanup')
  })
})

describe('resolveReleaseTag', () => {
  it('prefers the GitHub tag on the update info', () => {
    expect(
      resolveReleaseTag({
        tag: 'v2026-09-11.1',
        files: [{ url: 'https://github.com/memrynote/memry/releases/download/v0/x.exe' }]
      })
    ).toBe('v2026-09-11.1')
  })

  it('falls back to an absolute release-asset url', () => {
    expect(
      resolveReleaseTag({
        files: [
          { url: 'MemryNote-2026.911.1-setup.exe' },
          {
            url: 'https://github.com/memrynote/memry/releases/download/v2026-09-11.1/MemryNote-2026.911.1-setup.exe'
          }
        ]
      })
    ).toBe('v2026-09-11.1')
  })

  it('returns null when neither a tag nor an absolute url is present', () => {
    expect(resolveReleaseTag({ files: [{ url: 'MemryNote-2026.911.1-setup.exe' }] })).toBeNull()
    expect(resolveReleaseTag({ tag: '' })).toBeNull()
    expect(resolveReleaseTag({})).toBeNull()
  })
})

describe('velopackSetupUrl', () => {
  it('points at the Velopack Setup.exe of the release tag', () => {
    expect(velopackSetupUrl('v2026-09-11.1')).toBe(
      'https://github.com/memrynote/memry/releases/download/v2026-09-11.1/MemryNote-win-Setup.exe'
    )
  })
})

describe('judgeAuthenticode', () => {
  const subject = 'CN=Open Source Developer Kaan Karaca, O=Open Source Developer, C=TR'
  const expectedSubject = 'CN=Open Source Developer Kaan Karaca'

  it('accepts a Valid signature (Status 0) from the expected signer', () => {
    const stdout = JSON.stringify({
      Status: 0,
      StatusMessage: 'Signature verified.',
      SignerCertificate: { Subject: subject }
    })
    expect(judgeAuthenticode(stdout, expectedSubject)).toEqual({ ok: true, subject })
  })

  it('accepts a Valid signature rendered as the enum name', () => {
    const stdout = JSON.stringify({ Status: 'Valid', SignerCertificate: { Subject: subject } })
    expect(judgeAuthenticode(stdout, expectedSubject)).toEqual({ ok: true, subject })
  })

  it('rejects a Valid signature from another signer', () => {
    const stdout = JSON.stringify({
      Status: 0,
      SignerCertificate: { Subject: 'CN=Someone Else, O=Elsewhere' }
    })
    expect(judgeAuthenticode(stdout, expectedSubject)).toEqual({
      ok: false,
      reason: 'unexpected signer CN=Someone Else, O=Elsewhere'
    })
  })

  it('rejects an unsigned file (Status 2)', () => {
    const stdout = JSON.stringify({
      Status: 2,
      StatusMessage: 'The file is not digitally signed.',
      SignerCertificate: null
    })
    expect(judgeAuthenticode(stdout, expectedSubject)).toEqual({
      ok: false,
      reason: 'signature status 2 (The file is not digitally signed.)'
    })
  })

  it('rejects output that is not JSON', () => {
    expect(judgeAuthenticode('Get-AuthenticodeSignature : not found', expectedSubject)).toEqual({
      ok: false,
      reason: 'signature output is not JSON'
    })
  })
})

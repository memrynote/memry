import { describe, expect, it } from 'vitest'
import {
  handoffCmdArgs,
  handoffSpawnOptions,
  installerHandoffEnv,
  isHandoffInstallDirSupported,
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

const render = (): string[] => renderInstallerHandoffScript().split('\r\n')

describe('renderInstallerHandoffScript', () => {
  it('is static ASCII with CRLF line endings: no path, user name or code page can reach cmd', () => {
    const script = renderInstallerHandoffScript()

    // cmd.exe reads the .cmd in the OEM code page; the app writes UTF-8 (C:\Users\Kağan).
    expect(script).toMatch(/^[\x20-\x7e\r\n]*$/)
    expect(script.split('\r\n').join('')).not.toContain('\n')
    const values = [
      plan.installDir,
      plan.uninstallerPath,
      plan.workDir,
      plan.setupExePath,
      plan.setupLogPath,
      plan.handoffLogPath,
      plan.nsisInstallerPath ?? ''
    ]

    expect(values.filter((value) => value !== '' && script.includes(value))).toEqual([])
  })

  // A `)` in a path closed the `(echo ...)` group and the syntax error ended the batch before
  // anything ran, after the app had already quit. The redirect now comes first and the message
  // carries static text only.
  it('logs with a leading redirect and never interpolates a path into a message', () => {
    const lines = render()
    const logLine = lines.find((line) => line.includes('>>"%HANDOFF_LOG%"'))

    expect(logLine).toBe('>>"%HANDOFF_LOG%" echo %DATE% %TIME% %~1')
    const messages = lines.filter((line) => line.includes('call :log'))
    expect(messages.length).toBeGreaterThan(5)
    for (const line of messages) {
      expect(line).not.toMatch(
        /%(INSTALL_DIR|UNINSTALLER|WORK_DIR|SETUP|SETUP_LOG|HANDOFF_LOG|NSIS_INSTALLER)%/
      )
    }
  })

  it('records every step and its exit code', () => {
    const lines = render()

    expect(lines).toContain('call :log "app exited"')
    expect(lines).toContain('call :log "uninstall exit=%errorlevel%"')
    expect(lines).toContain('call :log "setup exit=%SETUP_EXIT%"')
    expect(lines).toContain('call :log "relaunch exit=%errorlevel%"')
    expect(lines).toContain('call :log "handoff done"')
  })

  // The script runs in a console-less cmd.exe (detached). A console program started there
  // without a console of its own breaks: `tasklist | find` hung forever on Windows 11 ARM64 and
  // on windows-2022. Only cmd builtins, GUI programs and powershell.exe are safe.
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
      'powershell',
      ')',
      '>>"%handoff_log%"'
    ])
    const commands = render()
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith(':'))
      .map((line) => line.split(/\s+/)[0].toLowerCase())

    expect(commands.filter((command) => !builtinsAndGui.has(command))).toEqual([])
  })

  // Inherited from a PowerShell 7 parent, PSModulePath makes Windows PowerShell 5.1 fail to load
  // its own modules, which turned the wait into "no such process" and let the uninstaller race
  // the still-running app.
  it('clears PSModulePath before powershell runs and fails the wait closed', () => {
    const lines = render()
    const waitAt = lines.findIndex((line) => line.startsWith('powershell '))

    expect(lines.indexOf('set "PSModulePath="')).toBeGreaterThan(-1)
    expect(lines.indexOf('set "PSModulePath="')).toBeLessThan(waitAt)
    expect(lines[waitAt]).toContain('[System.Diagnostics.Process]::GetProcessById(%APP_PID%)')
    expect(lines[waitAt]).toContain('WaitForExit(300000)')
    expect(lines[waitAt]).toContain('catch [System.ArgumentException]')
    expect(lines[waitAt]).not.toContain('Get-Process')
    expect(lines.slice(waitAt + 1, waitAt + 5)).toEqual([
      'if errorlevel 1 (',
      '  call :log "wait-for-exit failed"',
      '  goto fallback',
      ')'
    ])
  })

  it('routes a failed uninstaller copy to the fallback instead of running on', () => {
    const lines = render()
    const copyAt = lines.indexOf(
      String.raw`copy /y "%UNINSTALLER%" "%WORK_DIR%\Uninstall MemryNote.exe" >nul`
    )

    expect(lines[copyAt + 1]).toBe('if errorlevel 1 (')
    expect(lines[copyAt + 3]).toBe('  goto fallback')
  })

  // `Setup.exe --silent` installs without starting the app, so the script starts it. A Setup that
  // exits non-zero may still have left `current\Memrynote.exe`, a half install: it must not be
  // relaunched with the NSIS install already gone.
  it('relaunches Velopack only when Setup exited 0 and the exe exists', () => {
    const lines = render()
    const setupAt = lines.indexOf('start "" /wait "%SETUP%" --silent --verbose --log "%SETUP_LOG%"')

    expect(lines.slice(setupAt + 1, setupAt + 10)).toEqual([
      'set "SETUP_EXIT=%errorlevel%"',
      'call :log "setup exit=%SETUP_EXIT%"',
      '',
      'if not "%SETUP_EXIT%"=="0" goto fallback',
      'if not exist "%VELOPACK_EXE%" goto fallback',
      'call :log "result=velopack"',
      'start "" /d "%VELOPACK_DIR%" "%VELOPACK_EXE%"',
      'call :log "relaunch exit=%errorlevel%"',
      'goto cleanup'
    ])
  })

  // The invariant of the hand-off: Velopack installed and started, or Electron installed and
  // started, with a log line, whichever path failed.
  it('ends every fallback path in a reinstall or a relaunch of Electron, with a log line', () => {
    const lines = render()
    const at = (line: string): number => lines.indexOf(line)

    expect(lines.slice(at(':fallback'), at(':fallback') + 7)).toEqual([
      ':fallback',
      'call :log "falling back to nsis"',
      'if defined NSIS_INSTALLER if exist "%NSIS_INSTALLER%" goto run_nsis',
      'if exist "%INSTALL_DIR%\\%APP_EXE%" goto relaunch_original',
      'call :log "result=failed no-nsis-fallback"',
      'goto cleanup',
      ''
    ])
    expect(lines).toContain('start "" /wait "%NSIS_INSTALLER%" /S --force-run')
    expect(lines).toContain('start "" /d "%INSTALL_DIR%" "%INSTALL_DIR%\\%APP_EXE%"')
    expect(lines).toContain('call :log "result=electron-kept relaunch exit=%errorlevel%"')
  })
})

describe('installerHandoffEnv', () => {
  it('carries every plan path in the environment, byte for byte', () => {
    const odd: InstallerHandoffPlan = {
      ...plan,
      installDir: String.raw`D:\Apps (portable)\Kağan & 100%\MemryNote`,
      handoffLogPath: String.raw`C:\Users\Kağan (work)\AppData\Roaming\@memry\desktop\logs\installer-handoff.log`
    }
    const env = installerHandoffEnv(odd, { PATH: 'C:\\Windows', PSModulePath: 'x' })

    expect(env).toMatchObject({
      APP_PID: '1234',
      APP_EXE: 'Memrynote.exe',
      INSTALL_DIR: odd.installDir,
      UNINSTALLER: odd.uninstallerPath,
      WORK_DIR: odd.workDir,
      SETUP: odd.setupExePath,
      SETUP_LOG: odd.setupLogPath,
      HANDOFF_LOG: odd.handoffLogPath,
      NSIS_INSTALLER: odd.nsisInstallerPath,
      PATH: 'C:\\Windows'
    })
  })

  it('leaves NSIS_INSTALLER undefined when there is none and drops an inherited one', () => {
    const env = installerHandoffEnv(
      { ...plan, nsisInstallerPath: null },
      { nsis_installer: 'C:\\stale.exe', Setup: 'C:\\other.exe', KEEP: '1' }
    )

    expect('NSIS_INSTALLER' in env).toBe(false)
    expect(env).not.toHaveProperty('nsis_installer')
    expect(env.SETUP).toBe(plan.setupExePath)
    expect(env.KEEP).toBe('1')
  })
})

describe('isHandoffInstallDirSupported', () => {
  // `_?=%INSTALL_DIR%` must stay unquoted for NSIS, so cmd would parse these.
  it('accepts parentheses, spaces, percent signs and non-ASCII, rejects cmd operators', () => {
    expect(isHandoffInstallDirSupported(String.raw`D:\Apps (portable)\Kağan 100%\MemryNote`)).toBe(
      true
    )
    expect(isHandoffInstallDirSupported(String.raw`C:\a&b\MemryNote`)).toBe(false)
    expect(isHandoffInstallDirSupported(String.raw`C:\a^b`)).toBe(false)
  })
})

describe('handoffSpawnOptions', () => {
  it('spawns detached with no window and the plan in the environment', () => {
    expect(handoffSpawnOptions(plan, { PATH: 'p' })).toMatchObject({
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      windowsVerbatimArguments: true,
      env: { PATH: 'p', HANDOFF_LOG: plan.handoffLogPath }
    })
    expect(handoffCmdArgs(String.raw`C:\Users\a&b\x.cmd`)).toEqual([
      '/d',
      '/s',
      '/c',
      String.raw`""C:\Users\a&b\x.cmd""`
    ])
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

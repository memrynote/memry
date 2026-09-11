import { describe, expect, it } from 'vitest'
import {
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
  `set "NSIS_INSTALLER=${nsisInstaller}"`,
  String.raw`set "VELOPACK_EXE=%LocalAppData%\MemryNote\current\Memrynote.exe"`,
  '',
  ':wait_for_exit',
  'tasklist /FI "PID eq %APP_PID%" /FI "IMAGENAME eq %APP_EXE%" /NH 2>nul | find /I "%APP_EXE%" >nul',
  'if not errorlevel 1 (',
  '  ping -n 2 127.0.0.1 >nul',
  '  goto wait_for_exit',
  ')',
  '',
  'if not exist "%WORK_DIR%" mkdir "%WORK_DIR%"',
  String.raw`copy /y "%UNINSTALLER%" "%WORK_DIR%\Uninstall MemryNote.exe" >nul`,
  String.raw`start "" /wait "%WORK_DIR%\Uninstall MemryNote.exe" /S _?=%INSTALL_DIR%`,
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

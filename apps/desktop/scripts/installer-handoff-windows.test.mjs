// Runs the real hand-off script, spawned with the app's own options, on Windows, against fake
// uninstaller, Setup and NSIS installer, in directories whose names carry the characters that broke
// the previous script: non-ASCII, parentheses, `&` and `%`. Run in CI (velopack-smoke.yml) on x64 and
// ARM64: `node --test apps/desktop/scripts/installer-handoff-windows.test.mjs`. Skipped elsewhere.
//
// The fakes are batch files and copies of System32 exes, so this proves the script's control flow,
// quoting and logging, not Velopack or NSIS themselves (the migrate job does that).
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { describe, it } from 'node:test'
import {
  handoffCmdArgs,
  handoffSpawnOptions,
  renderInstallerHandoffScript
} from '../src/main/installer-handoff-script.ts'

const windows = process.platform === 'win32'
const system32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
const DONE_TIMEOUT_MS = 180_000

const seconds = (log, step) => {
  const match = new RegExp(`(\\d+):(\\d+):(\\d+)\\.\\d+ ${step}`).exec(log)
  assert.ok(match, `log lacks "${step}":\n${log}`)
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
}

async function exited(child) {
  if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve))
}

/** Lays out one scenario under a directory with hostile characters and runs the script on it. */
async function runHandoff({ setupExit, nsis, keepElectron = true, appAliveMs = 0 }) {
  const root = mkdtempSync(path.join(tmpdir(), 'Kağan (x) & 100%-'))
  const installDir = path.join(root, 'Apps (portable) Kağan 100%', 'MemryNote')
  const logDir = path.join(root, 'Roaming (x)', '@memry', 'desktop', 'logs')
  const localAppData = path.join(root, 'Local (x)')
  mkdirSync(installDir, { recursive: true })
  mkdirSync(logDir, { recursive: true })
  mkdirSync(localAppData, { recursive: true })
  copyFileSync(path.join(system32, 'whoami.exe'), path.join(installDir, 'Uninstall MemryNote.exe'))
  if (keepElectron)
    copyFileSync(path.join(system32, 'whoami.exe'), path.join(installDir, 'Memrynote.exe'))

  const setupPath = path.join(root, 'Setup (x).cmd')
  writeFileSync(
    setupPath,
    [
      '@echo off',
      'echo ran>"%~dp0setup-ran.txt"',
      'mkdir "%LOCALAPPDATA%\\MemryNote\\current"',
      `copy /y "${path.join(system32, 'whoami.exe')}" "%LOCALAPPDATA%\\MemryNote\\current\\Memrynote.exe" >nul`,
      `exit /b ${setupExit}`
    ].join('\r\n')
  )
  const nsisPath = path.join(root, 'nsis (x).cmd')
  writeFileSync(nsisPath, '@echo off\r\necho ran>"%~dp0nsis-ran.txt"\r\nexit /b 0\r\n')

  // A live app to wait for, or the PID of one that is already gone.
  const app = spawn(
    path.join(system32, 'PING.EXE'),
    ['-n', appAliveMs > 0 ? '9' : '1', '127.0.0.1'],
    {
      stdio: 'ignore',
      windowsHide: true
    }
  )
  if (appAliveMs === 0) await exited(app)

  const plan = {
    appPid: app.pid,
    appExeName: 'PING.EXE',
    installDir,
    uninstallerPath: path.join(installDir, 'Uninstall MemryNote.exe'),
    workDir: path.join(root, 'work (x)'),
    setupExePath: setupPath,
    setupLogPath: path.join(logDir, 'velopack-setup.log'),
    handoffLogPath: path.join(logDir, 'installer-handoff.log'),
    nsisInstallerPath: nsis ? nsisPath : null
  }
  const scriptPath = path.join(root, 'memry-installer-handoff-1.cmd')
  writeFileSync(scriptPath, renderInstallerHandoffScript())
  // An inherited PowerShell 7 PSModulePath is what broke the wait, so hand it to the script.
  const env = {
    ...process.env,
    LOCALAPPDATA: localAppData,
    PSModulePath: 'C:\\Program Files\\PowerShell\\7\\Modules'
  }
  spawn('cmd.exe', handoffCmdArgs(scriptPath), handoffSpawnOptions(plan, env)).unref()

  const deadline = Date.now() + DONE_TIMEOUT_MS
  const readLog = () =>
    existsSync(plan.handoffLogPath) ? readFileSync(plan.handoffLogPath, 'utf8') : ''
  while (Date.now() < deadline && !readLog().includes('handoff done')) await sleep(1000)
  const log = readLog()
  assert.ok(log.includes('handoff done'), `script did not finish:\n${log}`)
  return {
    log,
    setupRan: existsSync(path.join(root, 'setup-ran.txt')),
    nsisRan: existsSync(path.join(root, 'nsis-ran.txt'))
  }
}

describe('installer hand-off script on Windows', { skip: !windows }, () => {
  it('installs Velopack and relaunches, waiting for the live app first', async () => {
    const result = await runHandoff({ setupExit: 0, nsis: true, appAliveMs: 1 })

    assert.match(result.log, /result=velopack/)
    assert.match(result.log, /relaunch exit=0/)
    assert.ok(result.setupRan)
    assert.ok(!result.nsisRan)
    // The app lives about 8 s after the script starts; the uninstaller must not run before that.
    assert.ok(
      seconds(result.log, 'app exited') - seconds(result.log, 'handoff start') >= 4,
      result.log
    )
    assert.ok(seconds(result.log, 'uninstall exit=\\d+') >= seconds(result.log, 'app exited'))
  })

  it('reinstalls Electron through NSIS when Setup fails after creating its exe', async () => {
    const result = await runHandoff({ setupExit: 3, nsis: true })

    assert.match(result.log, /setup exit=3/)
    assert.doesNotMatch(result.log, /result=velopack/)
    assert.match(result.log, /result=nsis exit=0/)
    assert.ok(result.nsisRan)
  })

  it('relaunches the installed Electron when Setup fails and there is no NSIS installer', async () => {
    const result = await runHandoff({ setupExit: 3, nsis: false })

    assert.match(result.log, /result=electron-kept relaunch exit=0/)
    assert.doesNotMatch(result.log, /result=velopack/)
  })

  it('logs the failure when nothing can be restored', async () => {
    const result = await runHandoff({ setupExit: 3, nsis: false, keepElectron: false })

    assert.match(result.log, /result=failed no-nsis-fallback/)
    assert.match(result.log, /handoff done/)
  })
})

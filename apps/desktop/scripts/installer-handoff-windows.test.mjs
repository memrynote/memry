// Runs the real hand-off script, spawned with the app's own options, on Windows, against fake
// uninstaller, Setup and NSIS installer, in directories whose names carry the characters that broke
// the previous script: non-ASCII, parentheses, `&` and `%`. Run in CI (velopack-smoke.yml) on x64 and
// ARM64: `node --test apps/desktop/scripts/installer-handoff-windows.test.mjs`. Skipped elsewhere.
//
// The fakes are a small compiled stub and copies of System32 exes, so this proves the script's
// control flow, quoting and logging, not Velopack or NSIS themselves (the migrate job does that).
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
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
const DONE_TIMEOUT_MS = 90_000

// Log times are time-of-day, so a run across midnight wraps: differences are taken modulo a day.
const DAY = 86_400
const elapsed = (from, to) => (to - from + DAY) % DAY

const seconds = (log, step) => {
  const match = new RegExp(`(\\d+):(\\d+):(\\d+)\\.\\d+ ${step}`).exec(log)
  assert.ok(match, `log lacks "${step}":\n${log}`)
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
}

// Compiled once with the .NET Framework C# compiler that ships with Windows, x64 and ARM64.
const stubExe = (() => {
  if (!windows) return null
  const windir = process.env.windir ?? 'C:\\Windows'
  const csc = ['Framework64', 'Framework']
    .map((framework) => path.join(windir, 'Microsoft.NET', framework, 'v4.0.30319', 'csc.exe'))
    .find((candidate) => existsSync(candidate))
  if (!csc) {
    console.warn('csc.exe not found: the hand-off script scenarios are skipped')
    return null
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'handoff-stub-'))
  const source = path.join(dir, 'stub.cs')
  const exe = path.join(dir, 'stub.exe')
  const whoami = path.join(system32, 'whoami.exe').replaceAll('\\', '\\\\')
  writeFileSync(
    source,
    `using System; using System.IO;
class Stub { static int Main() {
  string self = System.Reflection.Assembly.GetExecutingAssembly().Location;
  File.WriteAllText(self + ".ran", "x");
  // The uninstaller copy lives in a work folder the script deletes, so its command line goes
  // beside the hand-off log, named after the stub copy.
  string log = Environment.GetEnvironmentVariable("HANDOFF_LOG");
  if (log != null) File.WriteAllText(log + "." + Path.GetFileName(self) + ".cmdline", Environment.CommandLine);
  if (File.Exists(self + ".creates")) {
    string dir = File.ReadAllText(self + ".creates");
    Directory.CreateDirectory(dir);
    File.Copy("${whoami}", Path.Combine(dir, "Memrynote.exe"), true);
  }
  return File.Exists(self + ".exit") ? int.Parse(File.ReadAllText(self + ".exit")) : 0;
} }`
  )
  const built = spawnSync(csc, ['/nologo', `/out:${exe}`, source], { encoding: 'utf8' })
  assert.equal(built.status, 0, `csc failed: ${built.stdout}${built.stderr}`)
  return exe
})()

async function exited(child) {
  if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve))
}

/** Lays out one scenario under a directory with hostile characters and runs the script on it. */
async function runHandoff({
  setupExit,
  nsis,
  keepElectron = true,
  keepAsar = true,
  appAliveMs = 0
}) {
  const root = mkdtempSync(path.join(tmpdir(), 'Kağan (x) & 100%-'))
  // The app refuses an install directory with `&` (the uninstaller's `_?=` is unquoted), so it
  // sits under a root without one; the log, work and temp roots keep the `&`.
  const installRoot = mkdtempSync(path.join(tmpdir(), 'Kağan (x) 100%-'))
  const installDir = path.join(installRoot, 'Apps (portable) Kağan 100%', 'MemryNote')
  const logDir = path.join(root, 'Roaming (x)', '@memry', 'desktop', 'logs')
  const localAppData = path.join(root, 'Local (x)')
  mkdirSync(installDir, { recursive: true })
  mkdirSync(logDir, { recursive: true })
  mkdirSync(localAppData, { recursive: true })
  copyFileSync(stubExe, path.join(installDir, 'Uninstall MemryNote.exe'))
  // The installed Electron app, named like the process the script waits for (APP_EXE), and
  // its app.asar: the script restarts it only when both are there.
  if (keepElectron) {
    copyFileSync(path.join(system32, 'whoami.exe'), path.join(installDir, 'PING.EXE'))
    if (keepAsar) {
      mkdirSync(path.join(installDir, 'resources'))
      writeFileSync(path.join(installDir, 'resources', 'app.asar'), 'x')
    }
  }

  // Real executables, like the real Setup.exe and NSIS installer: `%errorlevel%` after
  // `start /wait` of a script file is not the script's exit code. One compiled stub serves both;
  // beside the copy, `.exit` holds its exit code, `.creates` the folder to put Memrynote.exe in,
  // and it leaves `.ran` behind.
  const setupPath = path.join(root, 'Setup (x).exe')
  const nsisPath = path.join(root, 'nsis (x).exe')
  copyFileSync(stubExe, setupPath)
  copyFileSync(stubExe, nsisPath)
  writeFileSync(`${setupPath}.exit`, String(setupExit))
  writeFileSync(`${setupPath}.creates`, path.join(localAppData, 'MemryNote', 'current'))

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
  const uninstallerCommandLine = readFileSync(
    `${plan.handoffLogPath}.Uninstall MemryNote.exe.cmdline`,
    'utf8'
  )
  return {
    log,
    installDir,
    uninstallerCommandLine,
    setupRan: existsSync(`${setupPath}.ran`),
    nsisRan: existsSync(`${nsisPath}.ran`)
  }
}

describe('installer hand-off script on Windows', { skip: !stubExe }, () => {
  it('installs Velopack and relaunches, waiting for the live app first', async () => {
    const result = await runHandoff({ setupExit: 0, nsis: true, appAliveMs: 1 })

    assert.match(result.log, /result=velopack/)
    assert.match(result.log, /relaunch exit=0/)
    assert.ok(result.setupRan)
    assert.ok(!result.nsisRan)
    // The app lives about 8 s after the script starts; the uninstaller must not run before that.
    assert.ok(
      elapsed(seconds(result.log, 'handoff start'), seconds(result.log, 'app exited')) >= 4,
      result.log
    )
    assert.ok(
      elapsed(seconds(result.log, 'app exited'), seconds(result.log, 'uninstall exit=\\d+')) <
        DAY / 2
    )
    // NSIS needs `_?=<dir>` last and unquoted, whatever the directory holds.
    assert.ok(
      result.uninstallerCommandLine.endsWith(` /S _?=${result.installDir}`),
      result.uninstallerCommandLine
    )
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

  it('does not restart an Electron whose app.asar is gone', async () => {
    const result = await runHandoff({ setupExit: 3, nsis: false, keepAsar: false })

    assert.match(result.log, /result=failed no-nsis-fallback/)
    assert.doesNotMatch(result.log, /electron-kept/)
  })

  it('logs the failure when nothing can be restored', async () => {
    const result = await runHandoff({ setupExit: 3, nsis: false, keepElectron: false })

    assert.match(result.log, /result=failed no-nsis-fallback/)
    assert.match(result.log, /handoff done/)
  })
})

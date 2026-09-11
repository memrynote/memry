import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import {
  buildInstallerHandoffPlan,
  spawnInstallerHandoff,
  verifyAuthenticode,
  type InstallerHandoffDeps
} from '../installer-handoff'
import { detectWindowsInstallLayout } from '../windows-install-layout'

const USAGE = 'Usage: --cli migrate-installer <path-to-MemryNote-win-Setup.exe>'

export interface MigrateInstallerDeps {
  platform: NodeJS.Platform
  execPath: string
  pid: number
  tmpDir: string
  userDataDir: string
  fs: InstallerHandoffDeps['fs']
  verify: typeof verifyAuthenticode
  spawn: typeof spawnInstallerHandoff
  stdout(line: string): void
  stderr(line: string): void
}

function defaultDeps(): MigrateInstallerDeps {
  return {
    platform: process.platform,
    execPath: process.execPath,
    pid: process.pid,
    tmpDir: tmpdir(),
    userDataDir: app.getPath('userData'),
    fs,
    verify: verifyAuthenticode,
    spawn: spawnInstallerHandoff,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`)
  }
}

export async function runMigrateInstallerCommand(
  args: string[],
  overrides: Partial<MigrateInstallerDeps> = {}
): Promise<number> {
  const deps: MigrateInstallerDeps = { ...defaultDeps(), ...overrides }
  if (deps.platform !== 'win32') {
    deps.stderr('migrate-installer is only available on Windows.')
    return 1
  }
  const source = args[0]
  if (!source || !deps.fs.existsSync(source)) {
    deps.stderr(USAGE)
    return 1
  }
  if (detectWindowsInstallLayout(deps.execPath, deps.fs.existsSync) !== 'nsis') {
    deps.stderr('This is not an NSIS install of MemryNote; nothing to migrate.')
    return 1
  }

  const plan = buildInstallerHandoffPlan({
    pid: deps.pid,
    execPath: deps.execPath,
    tmpDir: deps.tmpDir,
    userDataDir: deps.userDataDir,
    nsisInstallerPath: null
  })
  const handoffDir = path.win32.dirname(plan.setupExePath)
  deps.fs.rmSync(handoffDir, { recursive: true, force: true })
  deps.fs.mkdirSync(handoffDir, { recursive: true })
  deps.fs.copyFileSync(source, plan.setupExePath)

  const verdict = await deps.verify(plan.setupExePath)
  if (!verdict.ok) {
    deps.fs.rmSync(handoffDir, { recursive: true, force: true })
    deps.stderr(`Refusing to run ${source}: ${verdict.reason}`)
    return 1
  }

  if (!deps.spawn(plan, { tmpDir: deps.tmpDir, pid: deps.pid, fs: deps.fs })) {
    return 1
  }
  deps.stdout(
    'Hand-off scheduled. MemryNote reinstalls with the new installer once this process exits.'
  )
  return 0
}

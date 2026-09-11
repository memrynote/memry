import { execFile as nodeExecFile, spawn as nodeSpawn } from 'node:child_process'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { app } from 'electron'
import type { UpdateDownloadedEvent } from 'electron-updater'
import { createLogger } from './lib/logger'
import {
  INSTALLER_HANDOFF_SIGNER_SUBJECT,
  VELOPACK_SETUP_ASSET_NAME,
  judgeAuthenticode,
  renderInstallerHandoffScript,
  resolveReleaseTag,
  velopackSetupUrl,
  type AuthenticodeVerdict,
  type InstallerHandoffPlan
} from './installer-handoff-script'
import type { UpdaterHost } from './updater-backend'
import { NSIS_UNINSTALLER_FILENAME, detectWindowsInstallLayout } from './windows-install-layout'

const logger = createLogger('InstallerHandoff')

export const INSTALLER_HANDOFF_DIRNAME = 'installer-handoff'

const AUTHENTICODE_TIMEOUT_MS = 60_000

export type InstallerHandoffState =
  | { status: 'idle' }
  | { status: 'preparing'; version: string }
  | { status: 'armed'; version: string; plan: InstallerHandoffPlan }
  | { status: 'launched'; version: string }
  | { status: 'declined'; version: string; reason: string }

export interface InstallerHandoff {
  /** After electron-updater downloaded the NSIS installer. Never rejects. Arms or declines. Re-entrant per version. */
  prepare(info: UpdateDownloadedEvent, onProgress: (percent: number) => void): Promise<void>
  /** True once a verified hand-off owns this install, and still true after launch() ran. */
  armed(): boolean
  /**
   * Write the script, spawn it detached. Runs at most once per armed plan. false when
   * not armed, already launched, or the spawn failed (caller then falls back to NSIS).
   */
  launch(): boolean
}

export interface InstallerHandoffDeps {
  userDataDir: string
  tmpDir: string
  execPath: string
  pid: number
  fetch: typeof fetch
  execFile: typeof nodeExecFile
  spawn: typeof nodeSpawn
  fs: Pick<
    typeof fs,
    'existsSync' | 'mkdirSync' | 'rmSync' | 'writeFileSync' | 'createWriteStream' | 'copyFileSync'
  >
}

type SpawnDeps = Pick<InstallerHandoffDeps, 'spawn' | 'tmpDir' | 'pid' | 'fs'>

function defaultDeps(): InstallerHandoffDeps {
  return {
    userDataDir: app.getPath('userData'),
    tmpDir: tmpdir(),
    execPath: process.execPath,
    pid: process.pid,
    fetch: (input, init) => fetch(input, init),
    execFile: nodeExecFile,
    spawn: nodeSpawn,
    fs
  }
}

const coded = (code: string, message: string): Error => Object.assign(new Error(message), { code })

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export function buildInstallerHandoffPlan(input: {
  pid: number
  execPath: string
  tmpDir: string
  userDataDir: string
  nsisInstallerPath: string | null
}): InstallerHandoffPlan {
  const installDir = path.win32.dirname(input.execPath)
  return {
    appPid: input.pid,
    appExeName: path.win32.basename(input.execPath),
    installDir,
    uninstallerPath: path.win32.join(installDir, NSIS_UNINSTALLER_FILENAME),
    workDir: path.win32.join(input.tmpDir, `memry-installer-handoff-${input.pid}`),
    setupExePath: path.win32.join(
      input.userDataDir,
      INSTALLER_HANDOFF_DIRNAME,
      VELOPACK_SETUP_ASSET_NAME
    ),
    setupLogPath: path.win32.join(input.userDataDir, 'logs', 'velopack-setup.log'),
    nsisInstallerPath: input.nsisInstallerPath
  }
}

/** Shared with the CLI. Runs powershell; resolves to a verdict, never rejects. */
export function verifyAuthenticode(
  filePath: string,
  deps: Pick<InstallerHandoffDeps, 'execFile'> = { execFile: nodeExecFile }
): Promise<AuthenticodeVerdict> {
  const literal = `'${filePath.replace(/'/g, "''")}'`
  const command = `Get-AuthenticodeSignature -LiteralPath ${literal} | ConvertTo-Json -Compress`
  return new Promise((resolve) => {
    deps.execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { windowsHide: true, timeout: AUTHENTICODE_TIMEOUT_MS },
      (error, stdout) => {
        if (error) {
          resolve({ ok: false, reason: `Get-AuthenticodeSignature failed: ${error.message}` })
          return
        }
        resolve(judgeAuthenticode(String(stdout), INSTALLER_HANDOFF_SIGNER_SUBJECT))
      }
    )
  })
}

/**
 * Shared with the CLI. Writes the script to `<tmpDir>\memry-installer-handoff-<pid>.cmd`
 * and spawns it through cmd.exe detached, the way electron-updater spawns its own installer.
 */
export function spawnInstallerHandoff(
  plan: InstallerHandoffPlan,
  deps: Partial<SpawnDeps> = {}
): boolean {
  const {
    spawn,
    tmpDir,
    pid,
    fs: fsDeps
  }: SpawnDeps = {
    spawn: nodeSpawn,
    tmpDir: tmpdir(),
    pid: process.pid,
    fs,
    ...deps
  }
  const scriptPath = path.win32.join(tmpDir, `memry-installer-handoff-${pid}.cmd`)
  try {
    fsDeps.writeFileSync(scriptPath, renderInstallerHandoffScript(plan))
    const child = spawn('cmd.exe', ['/c', scriptPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    child.on('error', (error) => {
      logger.error('installer hand-off script failed to start', error)
    })
    child.unref()
    logger.info('installer hand-off launched', { scriptPath, setupExePath: plan.setupExePath })
    return true
  } catch (error) {
    logger.error('installer hand-off launch failed', error)
    return false
  }
}

export function createInstallerHandoff(
  host: UpdaterHost,
  overrides: Partial<InstallerHandoffDeps> = {}
): InstallerHandoff {
  const deps: InstallerHandoffDeps = { ...defaultDeps(), ...overrides }
  const handoffDir = path.win32.join(deps.userDataDir, INSTALLER_HANDOFF_DIRNAME)

  const removeHandoffDir = (): void => {
    try {
      deps.fs.rmSync(handoffDir, { recursive: true, force: true })
    } catch (error) {
      logger.warn('could not remove the installer hand-off directory', { handoffDir, error })
    }
  }

  // A crash mid-hand-off must not leave the previous Setup.exe behind.
  removeHandoffDir()

  let state: InstallerHandoffState = { status: 'idle' }
  let inFlight: Promise<void> | null = null

  async function download(
    url: string,
    target: string,
    onProgress: (percent: number) => void
  ): Promise<void> {
    const res = await deps.fetch(url)
    if (!res.ok || !res.body) {
      throw new Error(`GET ${url} returned ${res.status}`)
    }
    const body = res.body
    const total = Number(res.headers.get('content-length')) || 0
    let received = 0
    onProgress(0)
    await pipeline(async function* () {
      for await (const chunk of body) {
        received += chunk.length
        if (total > 0) onProgress(Math.min(100, (received / total) * 100))
        yield chunk
      }
    }, deps.fs.createWriteStream(target))
    onProgress(100)
  }

  async function run(
    info: UpdateDownloadedEvent,
    onProgress: (percent: number) => void
  ): Promise<InstallerHandoffState> {
    const version = info.version
    const decline = (reason: string): InstallerHandoffState => {
      logger.info('installer hand-off declined', { version, reason })
      return { status: 'declined', version, reason }
    }

    const tag = resolveReleaseTag(info)
    if (!tag) return decline('release tag unknown')
    const layout = detectWindowsInstallLayout(deps.execPath, deps.fs.existsSync)
    if (layout !== 'nsis') return decline(`install layout is ${layout}, not nsis`)

    const url = velopackSetupUrl(tag)
    let head: Response
    try {
      head = await deps.fetch(url, { method: 'HEAD' })
    } catch (error) {
      host.onError(
        coded('INSTALLER_HANDOFF_DOWNLOAD_FAILED', `HEAD ${url} failed: ${messageOf(error)}`)
      )
      return decline('network error')
    }
    if (head.status === 404) return decline(`release ${tag} carries no Velopack installer`)
    if (!head.ok) {
      host.onError(
        coded('INSTALLER_HANDOFF_DOWNLOAD_FAILED', `HEAD ${url} returned ${head.status}`)
      )
      return decline(`HEAD returned ${head.status}`)
    }

    const plan = buildInstallerHandoffPlan({
      pid: deps.pid,
      execPath: deps.execPath,
      tmpDir: deps.tmpDir,
      userDataDir: deps.userDataDir,
      nsisInstallerPath: info.downloadedFile ?? null
    })
    removeHandoffDir()
    try {
      deps.fs.mkdirSync(handoffDir, { recursive: true })
      await download(url, plan.setupExePath, onProgress)
    } catch (error) {
      removeHandoffDir()
      host.onError(
        coded('INSTALLER_HANDOFF_DOWNLOAD_FAILED', `download of ${url} failed: ${messageOf(error)}`)
      )
      return decline('download failed')
    }

    const verdict = await verifyAuthenticode(plan.setupExePath, deps)
    if (!verdict.ok) {
      removeHandoffDir()
      host.onError(coded('INSTALLER_HANDOFF_UNVERIFIED', verdict.reason))
      return decline('signature not verified')
    }

    logger.info('installer hand-off armed', { version, tag, signer: verdict.subject })
    return { status: 'armed', version, plan }
  }

  return {
    prepare(info, onProgress) {
      const version = info.version
      if (state.status === 'preparing' && state.version === version && inFlight) {
        return inFlight
      }
      if (state.status !== 'idle' && state.status !== 'preparing' && state.version === version) {
        return Promise.resolve()
      }
      state = { status: 'preparing', version }
      inFlight = run(info, onProgress)
        .then((next) => {
          state = next
        })
        .catch((error: unknown) => {
          logger.error('installer hand-off preparation failed', error)
          state = { status: 'declined', version, reason: messageOf(error) }
        })
        .finally(() => {
          inFlight = null
        })
      return inFlight
    },
    armed() {
      return state.status === 'armed' || state.status === 'launched'
    },
    launch() {
      if (state.status !== 'armed') return false
      const { version, plan } = state
      // The shutdown backstop can race the shutdown sequence and reach
      // performQuitAndInstall() twice; a second uninstall + install must not run.
      state = { status: 'launched', version }
      return spawnInstallerHandoff(plan, deps)
    }
  }
}

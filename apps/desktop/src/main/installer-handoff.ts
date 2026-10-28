import { execFile as nodeExecFile, spawn as nodeSpawn, type SpawnOptions } from 'node:child_process'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { app } from 'electron'
import type { UpdateDownloadedEvent } from 'electron-updater'
import { formatAppVersionForDisplay } from './lib/app-version-display'
import { createLogger } from './lib/logger'
import {
  GITHUB_RELEASE_DOWNLOAD_BASE,
  INSTALLER_HANDOFF_SIGNER_SUBJECT,
  VELOPACK_SETUP_ASSET_NAME,
  handoffCmdArgs,
  handoffSpawnOptions,
  judgeAuthenticode,
  renderInstallerHandoffScript,
  resolveReleaseTag,
  velopackSetupUrl,
  type AuthenticodeVerdict,
  unsupportedHandoffInstallDirChar,
  type InstallerHandoffPlan
} from './installer-handoff-script'
import type { UpdateInstallAttempt } from './telemetry/update-install-marker'
import type { UpdaterHost } from './updater-backend'
import { NSIS_UNINSTALLER_FILENAME, detectWindowsInstallLayout } from './windows-install-layout'

const logger = createLogger('InstallerHandoff')

export const INSTALLER_HANDOFF_DIRNAME = 'installer-handoff'

/**
 * Holds the version whose hand-off ended with the old app still running (the script restarted
 * Electron, or nothing could be restored). Outside INSTALLER_HANDOFF_DIRNAME, which is wiped at
 * every start. Without it each session would re-download the 450 MB Setup and run the same
 * hand-off again; with it the next prepare() declines and electron-updater installs through
 * NSIS, which still delivers the update.
 */
const HANDOFF_FAILED_VERSION_FILENAME = 'installer-handoff-failed-version'

/**
 * Called at startup with the previous session's failed install (see detectFailedUpdateInstall).
 * Its marker is the proof: it names this build's hand-off and the version it was for, and the app
 * still runs the old version. The version is stored in the display form the marker carries, which
 * is the form prepare() compares against.
 */
export function noteFailedHandoffAttempt(
  attempt: Pick<UpdateInstallAttempt, 'installer' | 'toVersion'>,
  userDataDir: string = app.getPath('userData'),
  fsDeps: Pick<typeof fs, 'writeFileSync'> = fs
): void {
  if (attempt.installer !== 'velopack-handoff' || !attempt.toVersion) return
  try {
    fsDeps.writeFileSync(
      path.win32.join(userDataDir, HANDOFF_FAILED_VERSION_FILENAME),
      attempt.toVersion
    )
  } catch (error) {
    logger.warn('could not record the failed installer hand-off; it will be retried', {
      version: attempt.toVersion,
      error
    })
  }
}

/**
 * A cold powershell.exe takes 20 to 35 s to start on a hosted windows-11-arm runner and
 * Get-AuthenticodeSignature of the 45 MB Setup took over 60 s there, which declined the hand-off
 * as "signature not verified" twice (W2). The check runs while the update is still `downloading`,
 * so a longer ceiling costs nothing on a machine that answers in seconds.
 */
const AUTHENTICODE_TIMEOUT_MS = 180_000

/**
 * The Velopack installer is ~450 MB over a single GET. One dropped connection used
 * to lose the whole hand-off: production shows INSTALLER_HANDOFF_DOWNLOAD_FAILED
 * twice for the same user within an hour, with no retry anywhere in the path.
 */
const DOWNLOAD_ATTEMPTS = 3
const DOWNLOAD_RETRY_DELAY_MS = 3_000

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

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
  /** Backoff between download attempts. Zero in tests so the retry path costs nothing. */
  retryDelayMs: number
  userDataDir: string
  tmpDir: string
  execPath: string
  pid: number
  fetch: typeof fetch
  /**
   * Narrowed like `spawn` below. Passing `nodeExecFile` itself would not typecheck
   * against this — tsc resolves an overloaded function value against its last
   * overload — so the wrappers below call it instead, which picks the right
   * overload at the call site and leaves stubs directly assignable.
   */
  execFile: (
    file: string,
    args: readonly string[],
    options: HandoffExecFileOptions,
    callback: (error: Error | null, stdout: string, stderr: string) => void
  ) => void
  /**
   * Narrowed to the call the hand-off makes and the two members it uses on the
   * result. `typeof nodeSpawn` drags in every overload and the full ChildProcess
   * surface, which no injected stub can satisfy without a widening cast.
   */
  spawn: (command: string, args: readonly string[], options: SpawnOptions) => HandoffChild
  fs: Pick<
    typeof fs,
    'existsSync' | 'mkdirSync' | 'rmSync' | 'writeFileSync' | 'copyFileSync' | 'readFileSync'
  > & {
    /** Only ever piped into, so the Writable contract is the whole requirement. */
    createWriteStream: (path: string) => NodeJS.WritableStream
  }
}

/** The only execFile options the hand-off sets. */
interface HandoffExecFileOptions {
  windowsHide?: boolean
  timeout?: number
  env?: NodeJS.ProcessEnv
}

/**
 * `encoding` is what selects node's string-output overload; without it tsc offers
 * only the Buffer variants, whose callback cannot take a `string` stdout.
 */
const runExecFile: InstallerHandoffDeps['execFile'] = (file, args, options, callback) => {
  nodeExecFile(file, args, { ...options, encoding: 'utf8' as const }, callback)
}

/** What the hand-off actually uses from the spawned child. */
interface HandoffChild {
  unref(): void
  on(event: 'error', listener: (error: Error) => void): void
}

/** The CLI spawns without reading the failed-version record, so its fs stub need not provide it. */
type SpawnDeps = Pick<InstallerHandoffDeps, 'spawn' | 'tmpDir' | 'pid'> & {
  fs: Omit<InstallerHandoffDeps['fs'], 'readFileSync'>
}

function defaultDeps(): InstallerHandoffDeps {
  return {
    userDataDir: app.getPath('userData'),
    tmpDir: tmpdir(),
    execPath: process.execPath,
    pid: process.pid,
    fetch: (input, init) => fetch(releaseAssetUrl(input), init),
    execFile: runExecFile,
    spawn: nodeSpawn,
    retryDelayMs: DOWNLOAD_RETRY_DELAY_MS,
    fs
  }
}

/**
 * Every request the hand-off makes is for one release asset, so the allowlist is
 * enforced at the sink rather than only where the URL is built: a hostile release
 * tag, or any future caller, still cannot reach another host.
 */
function releaseAssetUrl(input: Parameters<typeof fetch>[0]): string {
  // Each arm of RequestInfo is unwrapped explicitly; a bare String() would turn a
  // Request into '[object Object]' and reject it for the wrong reason.
  const target = input instanceof URL ? input.href : input instanceof Request ? input.url : input
  if (!target.startsWith(`${GITHUB_RELEASE_DOWNLOAD_BASE}/`)) {
    throw new Error(`refusing to fetch outside the release download path: ${target}`)
  }
  return target
}

const coded = (code: string, message: string): Error => Object.assign(new Error(message), { code })

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
    handoffLogPath: path.win32.join(input.userDataDir, 'logs', 'installer-handoff.log'),
    nsisInstallerPath: input.nsisInstallerPath
  }
}

/**
 * powershell.exe is Windows PowerShell 5.1. When the app was started from a PowerShell 7 session
 * (or a launcher that copied its environment), the inherited PSModulePath lists PowerShell 7's
 * module folders, and 5.1 then fails to autoload Microsoft.PowerShell.Security: "the
 * 'Get-AuthenticodeSignature' command was found in the module, but the module could not be
 * loaded". That declined the hand-off with `signature not verified` on a clean installer (W2,
 * windows-2022). Dropping the variable makes 5.1 use its own default module path.
 */
function windowsPowerShellEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PSMODULEPATH')
  )
}

/** Shared with the CLI. Runs powershell; resolves to a verdict, never rejects. */
export function verifyAuthenticode(
  filePath: string,
  deps: Pick<InstallerHandoffDeps, 'execFile'> = { execFile: runExecFile }
): Promise<AuthenticodeVerdict> {
  const literal = `'${filePath.replace(/'/g, "''")}'`
  const command = `Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath ${literal} | ConvertTo-Json -Compress`
  return new Promise((resolve) => {
    deps.execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { windowsHide: true, timeout: AUTHENTICODE_TIMEOUT_MS, env: windowsPowerShellEnv() },
      (error, stdout) => {
        if (error) {
          resolve({ ok: false, reason: `Get-AuthenticodeSignature failed: ${error.message}` })
          return
        }
        resolve(judgeAuthenticode(stdout, INSTALLER_HANDOFF_SIGNER_SUBJECT))
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
    const badChar = unsupportedHandoffInstallDirChar(plan.installDir)
    if (badChar) {
      logger.error(
        'installer hand-off refused: install directory has a character cmd.exe would parse',
        {
          character: badChar
        }
      )
      return false
    }
    // The script's first line appends to this log, and a missing folder makes that fail silently.
    // The logger writes to its own folder, so <userData>\logs need not exist.
    fsDeps.mkdirSync(path.win32.dirname(plan.handoffLogPath), { recursive: true })
    fsDeps.writeFileSync(scriptPath, renderInstallerHandoffScript())
    const child = spawn(
      'cmd.exe',
      handoffCmdArgs(scriptPath),
      handoffSpawnOptions(plan, process.env)
    )
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

  async function downloadOnce(
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

    // A connection that drops mid-body still resolves the pipeline, leaving a short
    // file that would reach Authenticode and be reported as a signature problem
    // rather than the truncated download it actually is.
    if (total > 0 && received !== total) {
      throw new Error(`GET ${url} delivered ${received} of ${total} bytes`)
    }
    onProgress(100)
  }

  /** Each attempt restarts from zero; Range resume against GitHub's redirect chain is not worth it for three tries. */
  async function download(
    url: string,
    target: string,
    onProgress: (percent: number) => void
  ): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await downloadOnce(url, target, onProgress)
        return
      } catch (error) {
        if (attempt >= DOWNLOAD_ATTEMPTS) throw error
        logger.warn('Velopack installer download failed; retrying', {
          attempt,
          of: DOWNLOAD_ATTEMPTS,
          reason: error instanceof Error ? error.message : String(error)
        })
        await sleep(deps.retryDelayMs * attempt)
      }
    }
  }

  function failedVersion(): string | null {
    try {
      return deps.fs
        .readFileSync(path.win32.join(deps.userDataDir, HANDOFF_FAILED_VERSION_FILENAME), 'utf8')
        .trim()
    } catch {
      return null // no record: nothing failed before
    }
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
    const badChar = unsupportedHandoffInstallDirChar(path.win32.dirname(deps.execPath))
    if (badChar) {
      // Reported like a download or signature failure: this install can never migrate, and
      // the decline alone leaves no trace in error tracking. The message carries the character
      // only: a path would reach telemetry, whose redaction stops at the first space of a profile name.
      host.onError(
        coded(
          'INSTALLER_HANDOFF_UNSUPPORTED_INSTALL_DIR',
          `install directory contains '${badChar}'`
        )
      )
      return decline('install directory has a character the hand-off script cannot pass')
    }
    // The marker stores the display form of the version (updater state's availableVersion).
    if (failedVersion() === formatAppVersionForDisplay(version)) {
      return decline('a previous hand-off to this version left the old app running')
    }

    const url = velopackSetupUrl(tag)
    // `tag` arrives on the update payload. velopackSetupUrl encodes it into a fixed
    // GitHub release path, and this re-checks the built URL before any request
    // leaves the process, so a hostile tag cannot redirect the installer download.
    if (!url.startsWith(`${GITHUB_RELEASE_DOWNLOAD_BASE}/`)) {
      return decline('release url outside the GitHub release path')
    }
    let head: Response
    try {
      head = await deps.fetch(url, { method: 'HEAD' })
    } catch (error) {
      host.onError(
        coded(
          'INSTALLER_HANDOFF_DOWNLOAD_FAILED',
          `HEAD ${url} failed: ${error instanceof Error ? error.message : String(error)}`
        )
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
        coded(
          'INSTALLER_HANDOFF_DOWNLOAD_FAILED',
          `download of ${url} failed: ${error instanceof Error ? error.message : String(error)}`
        )
      )
      return decline('download failed')
    }

    const verifyStartedAt = Date.now()
    const verdict = await verifyAuthenticode(plan.setupExePath, deps)
    logger.info('installer hand-off signature check finished', {
      ok: verdict.ok,
      elapsedMs: Date.now() - verifyStartedAt
    })
    if (!verdict.ok) {
      removeHandoffDir()
      host.onError(coded('INSTALLER_HANDOFF_UNVERIFIED', verdict.reason))
      return decline('signature not verified')
    }

    // This version hands off, so a record left by an older failed one is stale.
    try {
      deps.fs.rmSync(path.win32.join(deps.userDataDir, HANDOFF_FAILED_VERSION_FILENAME), {
        force: true
      })
    } catch (error) {
      logger.warn('could not clear the failed installer hand-off record', { error })
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
      inFlight = (async () => {
        try {
          state = await run(info, onProgress)
        } catch (error) {
          logger.error('installer hand-off preparation failed', error)
          state = {
            status: 'declined',
            version,
            reason: error instanceof Error ? error.message : String(error)
          }
        } finally {
          inFlight = null
        }
      })()
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

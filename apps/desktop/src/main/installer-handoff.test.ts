import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import type { UpdateDownloadedEvent } from 'electron-updater'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => String.raw`C:\Users\kaan\AppData\Roaming\memrynote`) }
}))
vi.mock('./lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import {
  buildInstallerHandoffPlan,
  createInstallerHandoff,
  verifyAuthenticode,
  type InstallerHandoffDeps
} from './installer-handoff'
import { renderInstallerHandoffScript } from './installer-handoff-script'
import type { UpdaterHost } from './updater-backend'

const USER_DATA = String.raw`C:\Users\kaan\AppData\Roaming\memrynote`
const TMP = String.raw`C:\Users\kaan\AppData\Local\Temp`
const EXEC_PATH = String.raw`C:\Users\kaan\AppData\Local\Programs\MemryNote\Memrynote.exe`
const HANDOFF_DIR = path.win32.join(USER_DATA, 'installer-handoff')
const SETUP_URL =
  'https://github.com/memrynote/memry/releases/download/v2026-09-11.1/MemryNote-win-Setup.exe'
const NSIS_INSTALLER = String.raw`C:\Users\kaan\AppData\Local\memrynote-updater\pending\MemryNote-2026.911.1-setup.exe`
const VALID_SIGNATURE = JSON.stringify({
  Status: 0,
  SignerCertificate: { Subject: 'CN=Open Source Developer Kaan Karaca, C=TR' }
})

type DownloadedInfo = UpdateDownloadedEvent & { tag?: string }

function makeInfo(overrides: Partial<DownloadedInfo> = {}): DownloadedInfo {
  return {
    version: '2026.911.1',
    tag: 'v2026-09-11.1',
    files: [{ url: 'MemryNote-2026.911.1-setup.exe', sha512: 'sha' }],
    path: 'MemryNote-2026.911.1-setup.exe',
    sha512: 'sha',
    releaseDate: '2026-09-11',
    downloadedFile: NSIS_INSTALLER,
    ...overrides
  }
}

function makeHost(): UpdaterHost {
  return {
    onChecking: vi.fn(),
    onUpdateAvailable: vi.fn(() => true),
    onUpToDate: vi.fn(),
    onDownloadProgress: vi.fn(),
    onDownloaded: vi.fn(),
    onError: vi.fn(),
    currentPhase: vi.fn(() => 'download' as const),
    isAutoDownloadEnabled: vi.fn(() => true)
  }
}

function response(status: number, body?: Readable, contentLength?: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(
      contentLength === undefined ? {} : { 'content-length': `${contentLength}` }
    ),
    body
  } as unknown as Response
}

interface Harness {
  deps: InstallerHandoffDeps
  host: UpdaterHost
  written: Buffer[]
  fetch: ReturnType<typeof vi.fn>
  spawn: ReturnType<typeof vi.fn>
  child: { unref: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> }
  execFile: ReturnType<typeof vi.fn>
}

function makeHarness(
  options: { head?: Response; get?: () => Response; signature?: string } = {}
): Harness {
  const written: Buffer[] = []
  const child = { unref: vi.fn(), on: vi.fn() }
  const head = options.head ?? response(200)
  const get =
    options.get ??
    (() => response(200, Readable.from([Buffer.from('abcd'), Buffer.from('efghij')]), 10))
  const fetch = vi.fn(async (_url: string, init?: RequestInit) =>
    init?.method === 'HEAD' ? head : get()
  )
  const spawn = vi.fn(() => child)
  const execFile = vi.fn(
    (
      _file: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void
    ) => {
      callback(null, options.signature ?? VALID_SIGNATURE, '')
    }
  )
  const deps: InstallerHandoffDeps = {
    userDataDir: USER_DATA,
    tmpDir: TMP,
    execPath: EXEC_PATH,
    pid: 1234,
    fetch: fetch as unknown as typeof globalThis.fetch,
    execFile: execFile as unknown as InstallerHandoffDeps['execFile'],
    spawn: spawn as unknown as InstallerHandoffDeps['spawn'],
    fs: {
      existsSync: vi.fn((p: unknown) => String(p).endsWith('Uninstall MemryNote.exe')),
      mkdirSync: vi.fn(),
      rmSync: vi.fn(),
      writeFileSync: vi.fn(),
      copyFileSync: vi.fn(),
      createWriteStream: vi.fn(
        () =>
          new Writable({
            write(chunk: Buffer, _encoding, callback) {
              written.push(chunk)
              callback()
            }
          })
      ) as unknown as InstallerHandoffDeps['fs']['createWriteStream']
    }
  }
  return { deps, host: makeHost(), written, fetch, spawn, child, execFile }
}

const expectedPlan = (nsisInstallerPath: string | null = NSIS_INSTALLER) =>
  buildInstallerHandoffPlan({
    pid: 1234,
    execPath: EXEC_PATH,
    tmpDir: TMP,
    userDataDir: USER_DATA,
    nsisInstallerPath
  })

describe('createInstallerHandoff', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('removes a stale hand-off directory at startup', () => {
    const { deps, host } = makeHarness()

    createInstallerHandoff(host, deps)

    expect(deps.fs.rmSync).toHaveBeenCalledWith(HANDOFF_DIR, { recursive: true, force: true })
  })

  it('declines without an error when the release carries no Velopack installer', async () => {
    const harness = makeHarness({ head: response(404) })
    const handoff = createInstallerHandoff(harness.host, harness.deps)

    await handoff.prepare(makeInfo(), vi.fn())

    expect(harness.fetch).toHaveBeenCalledTimes(1)
    expect(harness.fetch).toHaveBeenCalledWith(SETUP_URL, { method: 'HEAD' })
    expect(harness.host.onError).not.toHaveBeenCalled()
    expect(handoff.armed()).toBe(false)
    expect(handoff.launch()).toBe(false)
  })

  it('reports a failed HEAD through the host and declines', async () => {
    const harness = makeHarness({ head: response(500) })
    const handoff = createInstallerHandoff(harness.host, harness.deps)

    await handoff.prepare(makeInfo(), vi.fn())

    expect(harness.host.onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'INSTALLER_HANDOFF_DOWNLOAD_FAILED' })
    )
    expect(harness.deps.fs.createWriteStream).not.toHaveBeenCalled()
    expect(handoff.armed()).toBe(false)
  })

  it('reports a network failure through the host and declines', async () => {
    const harness = makeHarness()
    harness.fetch.mockRejectedValue(new Error('ENOTFOUND github.com'))
    const handoff = createInstallerHandoff(harness.host, harness.deps)

    await handoff.prepare(makeInfo(), vi.fn())

    expect(harness.host.onError).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'INSTALLER_HANDOFF_DOWNLOAD_FAILED',
        message: expect.stringContaining('ENOTFOUND')
      })
    )
    expect(handoff.armed()).toBe(false)
  })

  it('streams the installer to disk and reports progress from 0 to 100', async () => {
    const harness = makeHarness()
    const handoff = createInstallerHandoff(harness.host, harness.deps)
    const onProgress = vi.fn()

    await handoff.prepare(makeInfo(), onProgress)

    expect(harness.fetch).toHaveBeenNthCalledWith(2, SETUP_URL)
    expect(harness.deps.fs.mkdirSync).toHaveBeenCalledWith(HANDOFF_DIR, { recursive: true })
    expect(harness.deps.fs.createWriteStream).toHaveBeenCalledWith(expectedPlan().setupExePath)
    expect(Buffer.concat(harness.written).toString()).toBe('abcdefghij')
    const percents = onProgress.mock.calls.map(([percent]) => percent as number)
    expect(percents[0]).toBe(0)
    expect(percents).toContain(40)
    expect(percents.at(-1)).toBe(100)
    expect(percents).toEqual([...percents].sort((a, b) => a - b))
  })

  it('reports a failed download through the host and removes the partial file', async () => {
    const harness = makeHarness({
      get: () =>
        response(
          200,
          new Readable({
            read() {
              this.destroy(new Error('connection reset'))
            }
          }),
          10
        )
    })
    const handoff = createInstallerHandoff(harness.host, harness.deps)

    await handoff.prepare(makeInfo(), vi.fn())

    expect(harness.host.onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'INSTALLER_HANDOFF_DOWNLOAD_FAILED' })
    )
    expect(harness.deps.fs.rmSync).toHaveBeenLastCalledWith(HANDOFF_DIR, {
      recursive: true,
      force: true
    })
    expect(handoff.armed()).toBe(false)
  })

  it('never arms an installer whose signature does not verify', async () => {
    const harness = makeHarness({
      signature: JSON.stringify({ Status: 2, StatusMessage: 'The file is not digitally signed.' })
    })
    const handoff = createInstallerHandoff(harness.host, harness.deps)

    await handoff.prepare(makeInfo(), vi.fn())

    expect(harness.execFile).toHaveBeenCalledWith(
      'powershell.exe',
      expect.arrayContaining(['-Command', expect.stringContaining(expectedPlan().setupExePath)]),
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function)
    )
    expect(harness.host.onError).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'INSTALLER_HANDOFF_UNVERIFIED',
        message: 'signature status 2 (The file is not digitally signed.)'
      })
    )
    expect(harness.deps.fs.rmSync).toHaveBeenLastCalledWith(HANDOFF_DIR, {
      recursive: true,
      force: true
    })
    expect(handoff.armed()).toBe(false)
    expect(handoff.launch()).toBe(false)
    expect(harness.spawn).not.toHaveBeenCalled()
  })

  it('arms after a verified download and launches the detached script', async () => {
    const harness = makeHarness()
    const handoff = createInstallerHandoff(harness.host, harness.deps)

    await handoff.prepare(makeInfo(), vi.fn())
    expect(handoff.armed()).toBe(true)

    expect(handoff.launch()).toBe(true)

    const scriptPath = path.win32.join(TMP, 'memry-installer-handoff-1234.cmd')
    expect(harness.deps.fs.writeFileSync).toHaveBeenCalledWith(
      scriptPath,
      renderInstallerHandoffScript(expectedPlan())
    )
    expect(harness.spawn).toHaveBeenCalledWith('cmd.exe', ['/c', scriptPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    expect(harness.child.unref).toHaveBeenCalledTimes(1)
  })

  it('launches once so a second quit path cannot uninstall and install twice', async () => {
    const harness = makeHarness()
    const handoff = createInstallerHandoff(harness.host, harness.deps)

    await handoff.prepare(makeInfo(), vi.fn())

    expect(handoff.launch()).toBe(true)
    expect(handoff.launch()).toBe(false)
    expect(harness.spawn).toHaveBeenCalledTimes(1)
    // Still the hand-off's install, so a second marker write keeps naming it.
    expect(handoff.armed()).toBe(true)
  })

  it('returns false from launch when the spawn throws', async () => {
    const harness = makeHarness()
    harness.spawn.mockImplementation(() => {
      throw new Error('spawn cmd.exe EPERM')
    })
    const handoff = createInstallerHandoff(harness.host, harness.deps)

    await handoff.prepare(makeInfo(), vi.fn())

    expect(handoff.launch()).toBe(false)
  })

  it('does not download again when the same version is reported twice', async () => {
    const harness = makeHarness()
    const handoff = createInstallerHandoff(harness.host, harness.deps)

    await handoff.prepare(makeInfo(), vi.fn())
    const fetches = harness.fetch.mock.calls.length
    await handoff.prepare(makeInfo(), vi.fn())

    expect(harness.fetch).toHaveBeenCalledTimes(fetches)
    expect(handoff.armed()).toBe(true)
  })

  it('shares one in-flight preparation between concurrent calls for the same version', async () => {
    const harness = makeHarness()
    const handoff = createInstallerHandoff(harness.host, harness.deps)

    await Promise.all([handoff.prepare(makeInfo(), vi.fn()), handoff.prepare(makeInfo(), vi.fn())])

    expect(harness.fetch).toHaveBeenCalledTimes(2)
    expect(handoff.armed()).toBe(true)
  })

  it('declines before any network access when this is not an NSIS install', async () => {
    const harness = makeHarness()
    vi.mocked(harness.deps.fs.existsSync).mockReturnValue(false)
    const handoff = createInstallerHandoff(harness.host, harness.deps)

    await handoff.prepare(makeInfo(), vi.fn())

    expect(harness.fetch).not.toHaveBeenCalled()
    expect(harness.host.onError).not.toHaveBeenCalled()
    expect(handoff.armed()).toBe(false)
  })

  it('declines before any network access when the release tag is unknown', async () => {
    const harness = makeHarness()
    const handoff = createInstallerHandoff(harness.host, harness.deps)

    await handoff.prepare(makeInfo({ tag: undefined }), vi.fn())

    expect(harness.fetch).not.toHaveBeenCalled()
    expect(handoff.armed()).toBe(false)
  })
})

describe('verifyAuthenticode', () => {
  it('turns a powershell failure into a verdict instead of a rejection', async () => {
    const execFile = vi.fn(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void
      ) => {
        callback(new Error('spawn powershell.exe ENOENT'), '', '')
      }
    )

    await expect(
      verifyAuthenticode(String.raw`C:\x\Setup.exe`, {
        execFile: execFile as unknown as InstallerHandoffDeps['execFile']
      })
    ).resolves.toEqual({
      ok: false,
      reason: 'Get-AuthenticodeSignature failed: spawn powershell.exe ENOENT'
    })
  })
})

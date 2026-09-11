import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => 'C:\\Users\\kaan\\AppData\\Roaming\\memrynote') }
}))
vi.mock('../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import { runMigrateInstallerCommand, type MigrateInstallerDeps } from './migrate-installer'

const EXEC_PATH = 'C:\\Users\\kaan\\AppData\\Local\\Programs\\MemryNote\\Memrynote.exe'
const USER_DATA = 'C:\\Users\\kaan\\AppData\\Roaming\\memrynote'
const SOURCE = 'C:\\Users\\kaan\\Downloads\\MemryNote-win-Setup.exe'
const SETUP_COPY = path.win32.join(USER_DATA, 'installer-handoff', 'MemryNote-win-Setup.exe')
const HANDOFF_DIR = path.win32.join(USER_DATA, 'installer-handoff')

function makeDeps(overrides: Partial<MigrateInstallerDeps> = {}) {
  const stdout: string[] = []
  const stderr: string[] = []
  const deps: MigrateInstallerDeps = {
    platform: 'win32',
    execPath: EXEC_PATH,
    pid: 4321,
    tmpDir: 'C:\\Temp',
    userDataDir: USER_DATA,
    fs: {
      existsSync: vi.fn(
        (p: unknown) => String(p) === SOURCE || String(p).endsWith('Uninstall MemryNote.exe')
      ),
      mkdirSync: vi.fn(),
      rmSync: vi.fn(),
      writeFileSync: vi.fn(),
      copyFileSync: vi.fn(),
      createWriteStream: vi.fn()
    } as unknown as MigrateInstallerDeps['fs'],
    verify: vi.fn(async () => ({
      ok: true as const,
      subject: 'CN=Open Source Developer Kaan Karaca'
    })),
    spawn: vi.fn(() => true),
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    ...overrides
  }
  return { deps, stdout, stderr }
}

describe('migrate-installer command', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('is Windows only', async () => {
    const { deps, stderr } = makeDeps({ platform: 'darwin' })

    await expect(runMigrateInstallerCommand([SOURCE], deps)).resolves.toBe(1)

    expect(stderr).toEqual(['migrate-installer is only available on Windows.'])
    expect(deps.spawn).not.toHaveBeenCalled()
  })

  it('prints usage without a path', async () => {
    const { deps, stderr } = makeDeps()

    await expect(runMigrateInstallerCommand([], deps)).resolves.toBe(1)

    expect(stderr).toEqual(['Usage: --cli migrate-installer <path-to-MemryNote-win-Setup.exe>'])
  })

  it('prints usage when the file does not exist', async () => {
    const { deps, stderr } = makeDeps()

    await expect(runMigrateInstallerCommand(['C:\\missing\\Setup.exe'], deps)).resolves.toBe(1)

    expect(stderr).toEqual(['Usage: --cli migrate-installer <path-to-MemryNote-win-Setup.exe>'])
    expect(deps.verify).not.toHaveBeenCalled()
  })

  it('refuses when the running app is not an NSIS install', async () => {
    const { deps, stderr } = makeDeps()
    vi.mocked(deps.fs.existsSync).mockImplementation((p: unknown) => String(p) === SOURCE)

    await expect(runMigrateInstallerCommand([SOURCE], deps)).resolves.toBe(1)

    expect(stderr).toEqual(['This is not an NSIS install of MemryNote; nothing to migrate.'])
    expect(deps.fs.copyFileSync).not.toHaveBeenCalled()
  })

  it('verifies the copy and refuses to run an installer that does not verify', async () => {
    const { deps, stderr } = makeDeps({
      verify: vi.fn(async () => ({ ok: false as const, reason: 'signature status 2' }))
    })

    await expect(runMigrateInstallerCommand([SOURCE], deps)).resolves.toBe(1)

    expect(deps.fs.copyFileSync).toHaveBeenCalledWith(SOURCE, SETUP_COPY)
    expect(deps.verify).toHaveBeenCalledWith(SETUP_COPY)
    expect(deps.fs.rmSync).toHaveBeenLastCalledWith(HANDOFF_DIR, { recursive: true, force: true })
    expect(stderr).toEqual([`Refusing to run ${SOURCE}: signature status 2`])
    expect(deps.spawn).not.toHaveBeenCalled()
  })

  it('fails when the hand-off script cannot be spawned', async () => {
    const { deps, stdout } = makeDeps({ spawn: vi.fn(() => false) })

    await expect(runMigrateInstallerCommand([SOURCE], deps)).resolves.toBe(1)

    expect(stdout).toEqual([])
  })

  it('schedules the hand-off from a verified copy', async () => {
    const { deps, stdout, stderr } = makeDeps()

    await expect(runMigrateInstallerCommand([SOURCE], deps)).resolves.toBe(0)

    expect(deps.fs.rmSync).toHaveBeenCalledWith(HANDOFF_DIR, { recursive: true, force: true })
    expect(deps.fs.mkdirSync).toHaveBeenCalledWith(HANDOFF_DIR, { recursive: true })
    expect(deps.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        appPid: 4321,
        appExeName: 'Memrynote.exe',
        installDir: 'C:\\Users\\kaan\\AppData\\Local\\Programs\\MemryNote',
        setupExePath: SETUP_COPY,
        nsisInstallerPath: null
      }),
      { tmpDir: 'C:\\Temp', pid: 4321, fs: deps.fs }
    )
    expect(stdout).toEqual([
      'Hand-off scheduled. MemryNote reinstalls with the new installer once this process exits.'
    ])
    expect(stderr).toEqual([])
  })
})

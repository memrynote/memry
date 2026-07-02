import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingInstallInput } from './updater-install-guard'

const mocks = vi.hoisted(() => ({
  app: {
    isPackaged: true,
    getVersion: vi.fn(() => '2026.702.2'),
    getPath: vi.fn((name: string) => `/userdata/${name}`)
  },
  fs: {
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(),
    rmSync: vi.fn(),
    statSync: vi.fn()
  },
  child_process: {
    execFileSync: vi.fn()
  }
}))

vi.mock('electron', () => ({ app: mocks.app }))
vi.mock('node:fs', () => mocks.fs)
vi.mock('node:child_process', () => mocks.child_process)
vi.mock('node:os', () => ({ homedir: () => '/home/tester' }))
vi.mock('./lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

const realPlatform = process.platform
function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

async function load() {
  vi.resetModules()
  return import('./updater-install-guard')
}

const FRESH = 5 * 60 * 1000

function baseInput(overrides: Partial<PendingInstallInput> = {}): PendingInstallInput {
  return {
    marker: { fromVersion: '2026.702.2', createdAt: 1_000 },
    currentVersion: '2026.702.2',
    now: 2_000,
    plistExists: true,
    plistMtimeMs: 1_500,
    shipItProcessAlive: true,
    ...overrides
  }
}

describe('shouldGuardForPendingInstall', () => {
  it('fires when every signal agrees the install is in flight', async () => {
    const { shouldGuardForPendingInstall } = await load()
    expect(shouldGuardForPendingInstall(baseInput())).toBe(true)
  })

  it('does not fire without a marker', async () => {
    const { shouldGuardForPendingInstall } = await load()
    expect(shouldGuardForPendingInstall(baseInput({ marker: null }))).toBe(false)
  })

  it('does not fire once the running version differs (install already swapped in)', async () => {
    const { shouldGuardForPendingInstall } = await load()
    expect(shouldGuardForPendingInstall(baseInput({ currentVersion: '2026.702.4' }))).toBe(false)
  })

  it('does not fire for a stale marker (abandoned install)', async () => {
    const { shouldGuardForPendingInstall } = await load()
    const now = 10 * FRESH
    expect(
      shouldGuardForPendingInstall(
        baseInput({ now, marker: { fromVersion: '2026.702.2', createdAt: now - FRESH - 1 } })
      )
    ).toBe(false)
  })

  it('does not fire when no ShipIt process is running (failed/aborted install)', async () => {
    const { shouldGuardForPendingInstall } = await load()
    expect(shouldGuardForPendingInstall(baseInput({ shipItProcessAlive: false }))).toBe(false)
  })

  it('does not fire without a ShipItState.plist', async () => {
    const { shouldGuardForPendingInstall } = await load()
    expect(
      shouldGuardForPendingInstall(baseInput({ plistExists: false, plistMtimeMs: null }))
    ).toBe(false)
  })

  it('does not fire for a stale ShipItState.plist', async () => {
    const { shouldGuardForPendingInstall } = await load()
    const now = 10 * FRESH
    expect(shouldGuardForPendingInstall(baseInput({ now, plistMtimeMs: now - FRESH - 1 }))).toBe(
      false
    )
  })
})

describe('marker IO', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setPlatform('darwin')
    mocks.app.isPackaged = true
    mocks.app.getVersion.mockReturnValue('2026.702.2')
    mocks.app.getPath.mockImplementation((name: string) => `/userdata/${name}`)
  })

  afterAll(() => setPlatform(realPlatform))

  it('writes the marker with the initiating version to userData', async () => {
    const { writePendingInstallMarker } = await load()
    writePendingInstallMarker('2026.702.2', 4_242)
    expect(mocks.fs.writeFileSync).toHaveBeenCalledWith(
      '/userdata/userData/pending-update-install.json',
      JSON.stringify({ fromVersion: '2026.702.2', createdAt: 4_242 })
    )
  })

  it('does not write the marker on non-darwin platforms', async () => {
    setPlatform('win32')
    const { writePendingInstallMarker } = await load()
    writePendingInstallMarker('2026.702.2')
    expect(mocks.fs.writeFileSync).not.toHaveBeenCalled()
  })

  it('clears the marker with force', async () => {
    const { clearPendingInstallMarker } = await load()
    clearPendingInstallMarker()
    expect(mocks.fs.rmSync).toHaveBeenCalledWith('/userdata/userData/pending-update-install.json', {
      force: true
    })
  })
})

describe('isPendingInstallInFlight', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setPlatform('darwin')
    mocks.app.isPackaged = true
    mocks.app.getVersion.mockReturnValue('2026.702.2')
    mocks.app.getPath.mockImplementation((name: string) => `/userdata/${name}`)
    mocks.fs.readFileSync.mockReturnValue(
      JSON.stringify({ fromVersion: '2026.702.2', createdAt: 1_000 })
    )
    mocks.fs.statSync.mockReturnValue({ mtimeMs: 1_500 })
    mocks.child_process.execFileSync.mockReturnValue('54321\n')
  })

  afterAll(() => setPlatform(realPlatform))

  it('returns true and queries pgrep for the ShipIt process only after cheap checks pass', async () => {
    const { isPendingInstallInFlight } = await load()
    expect(isPendingInstallInFlight(2_000)).toBe(true)
    expect(mocks.child_process.execFileSync).toHaveBeenCalledWith(
      'pgrep',
      ['-f', 'com.memrynote.memry.ShipIt'],
      expect.anything()
    )
  })

  it('returns false without shelling out when no marker exists', async () => {
    mocks.fs.readFileSync.mockImplementation(() => {
      throw new Error('ENOENT')
    })
    const { isPendingInstallInFlight } = await load()
    expect(isPendingInstallInFlight(2_000)).toBe(false)
    expect(mocks.child_process.execFileSync).not.toHaveBeenCalled()
  })

  it('returns false without shelling out when the running version differs', async () => {
    mocks.app.getVersion.mockReturnValue('2026.702.4')
    const { isPendingInstallInFlight } = await load()
    expect(isPendingInstallInFlight(2_000)).toBe(false)
    expect(mocks.child_process.execFileSync).not.toHaveBeenCalled()
  })

  it('returns false without shelling out when the ShipItState.plist is missing', async () => {
    mocks.fs.statSync.mockImplementation(() => {
      throw new Error('ENOENT')
    })
    const { isPendingInstallInFlight } = await load()
    expect(isPendingInstallInFlight(2_000)).toBe(false)
    expect(mocks.child_process.execFileSync).not.toHaveBeenCalled()
  })

  it('returns false when pgrep finds no ShipIt process', async () => {
    mocks.child_process.execFileSync.mockImplementation(() => {
      throw new Error('no match')
    })
    const { isPendingInstallInFlight } = await load()
    expect(isPendingInstallInFlight(2_000)).toBe(false)
  })

  it('returns false on non-darwin platforms', async () => {
    setPlatform('linux')
    const { isPendingInstallInFlight } = await load()
    expect(isPendingInstallInFlight(2_000)).toBe(false)
    expect(mocks.fs.readFileSync).not.toHaveBeenCalled()
  })
})

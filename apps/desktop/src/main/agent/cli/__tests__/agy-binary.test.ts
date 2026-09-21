import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  locateBinary: vi.fn<(name: string) => Promise<string | null>>(),
  runBinaryCommand:
    vi.fn<(command: string, args: string[]) => Promise<{ stdout: string; stderr: string } | null>>()
}))

// Real `cacheBinaryDetection` — the caching contract is part of what is tested.
vi.mock('../binary-detection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../binary-detection')>()
  return { ...actual, locateBinary: mocks.locateBinary, runBinaryCommand: mocks.runBinaryCommand }
})

import { MIN_AGY_VERSION } from '../agy-binary'

/** Fresh module instance so each test starts with an empty detection cache. */
async function loadDetector() {
  vi.resetModules()
  const mod = await import('../agy-binary')
  return mod.detectAgyBinary
}

describe('detectAgyBinary', () => {
  beforeEach(() => {
    mocks.locateBinary.mockReset()
    mocks.runBinaryCommand.mockReset()
  })

  it('reports the installed agy version when it meets the minimum', async () => {
    mocks.locateBinary.mockResolvedValue('/Users/me/.local/bin/agy')
    mocks.runBinaryCommand.mockResolvedValue({ stdout: '1.2.7\n', stderr: '' })
    const detectAgyBinary = await loadDetector()

    await expect(detectAgyBinary()).resolves.toEqual({
      detected: true,
      version: '1.2.7',
      meetsMinimum: true,
      minimumRequired: MIN_AGY_VERSION,
      installHint: null
    })
    expect(mocks.locateBinary).toHaveBeenCalledWith('agy')
  })

  it('reads the version from stderr when agy prints it there', async () => {
    mocks.locateBinary.mockResolvedValue('/Users/me/.local/bin/agy')
    mocks.runBinaryCommand.mockResolvedValue({ stdout: '', stderr: 'agy version 1.3.0\n' })
    const detectAgyBinary = await loadDetector()

    await expect(detectAgyBinary()).resolves.toMatchObject({ version: '1.3.0', meetsMinimum: true })
  })

  it('surfaces install guidance when agy is missing', async () => {
    mocks.locateBinary.mockResolvedValue(null)
    const detectAgyBinary = await loadDetector()

    const status = await detectAgyBinary()

    expect(status.detected).toBe(false)
    expect(status.minimumRequired).toBe(MIN_AGY_VERSION)
    expect(status.installHint).toContain('agy')
  })

  it('keeps the install hint when the installed build is older than the floor', async () => {
    mocks.locateBinary.mockResolvedValue('/Users/me/.local/bin/agy')
    mocks.runBinaryCommand.mockResolvedValue({ stdout: '1.1.9\n', stderr: '' })
    const detectAgyBinary = await loadDetector()

    const status = await detectAgyBinary()

    // Below 1.2.7 the MCP config path and the headless timeout behaviour
    // differ, so a turn would fail in ways the backend cannot explain.
    expect(status).toMatchObject({ detected: true, version: '1.1.9', meetsMinimum: false })
    expect(status.installHint).toContain('agy')
  })

  it('reports a binary whose version cannot be read as unusable', async () => {
    mocks.locateBinary.mockResolvedValue('/Users/me/.local/bin/agy')
    mocks.runBinaryCommand.mockResolvedValue(null)
    const detectAgyBinary = await loadDetector()

    await expect(detectAgyBinary()).resolves.toMatchObject({
      detected: true,
      version: null,
      meetsMinimum: false
    })
  })

  it('probes once when a usable binary is asked for repeatedly', async () => {
    mocks.locateBinary.mockResolvedValue('/Users/me/.local/bin/agy')
    mocks.runBinaryCommand.mockResolvedValue({ stdout: '1.2.7\n', stderr: '' })
    const detectAgyBinary = await loadDetector()

    await detectAgyBinary()
    await detectAgyBinary()

    expect(mocks.locateBinary).toHaveBeenCalledTimes(1)
    expect(mocks.runBinaryCommand).toHaveBeenCalledTimes(1)
  })

  it('re-probes after a miss so installing the CLI mid-session is picked up', async () => {
    mocks.locateBinary.mockResolvedValueOnce(null)
    const detectAgyBinary = await loadDetector()

    expect((await detectAgyBinary()).detected).toBe(false)

    mocks.locateBinary.mockResolvedValue('/Users/me/.local/bin/agy')
    mocks.runBinaryCommand.mockResolvedValue({ stdout: '1.2.7\n', stderr: '' })

    expect((await detectAgyBinary()).detected).toBe(true)
  })
})

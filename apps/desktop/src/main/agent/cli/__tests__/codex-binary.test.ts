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

import { MIN_CODEX_VERSION } from '../codex-binary'

/** Fresh module instance so each test starts with an empty detection cache. */
async function loadDetector() {
  vi.resetModules()
  const mod = await import('../codex-binary')
  return mod.detectCodexBinary
}

describe('detectCodexBinary', () => {
  beforeEach(() => {
    mocks.locateBinary.mockReset()
    mocks.runBinaryCommand.mockReset()
  })

  it('reports the installed codex version when it meets the minimum', async () => {
    mocks.locateBinary.mockResolvedValue('/opt/homebrew/bin/codex')
    mocks.runBinaryCommand.mockResolvedValue({ stdout: 'codex-cli 0.130.0\n', stderr: '' })
    const detectCodexBinary = await loadDetector()

    await expect(detectCodexBinary()).resolves.toEqual({
      detected: true,
      version: '0.130.0',
      meetsMinimum: true,
      minimumRequired: MIN_CODEX_VERSION,
      installHint: null
    })
  })

  it('reads the version from stderr when codex prints it there', async () => {
    mocks.locateBinary.mockResolvedValue('/opt/homebrew/bin/codex')
    mocks.runBinaryCommand.mockResolvedValue({ stdout: '', stderr: 'codex-cli 0.130.0\n' })
    const detectCodexBinary = await loadDetector()

    await expect(detectCodexBinary()).resolves.toMatchObject({ version: '0.130.0' })
  })

  it('surfaces install guidance when codex is missing', async () => {
    mocks.locateBinary.mockResolvedValue(null)
    const detectCodexBinary = await loadDetector()

    const status = await detectCodexBinary()

    expect(status.detected).toBe(false)
    expect(status.minimumRequired).toBe(MIN_CODEX_VERSION)
    expect(status.installHint).toContain('codex')
  })

  it('probes once when a usable binary is asked for repeatedly', async () => {
    mocks.locateBinary.mockResolvedValue('/opt/homebrew/bin/codex')
    mocks.runBinaryCommand.mockResolvedValue({ stdout: 'codex-cli 0.130.0\n', stderr: '' })
    const detectCodexBinary = await loadDetector()

    await detectCodexBinary()
    await detectCodexBinary()

    expect(mocks.locateBinary).toHaveBeenCalledTimes(1)
    expect(mocks.runBinaryCommand).toHaveBeenCalledTimes(1)
  })

  it('re-probes after a miss so installing the CLI mid-session is picked up', async () => {
    mocks.locateBinary.mockResolvedValueOnce(null)
    const detectCodexBinary = await loadDetector()

    expect((await detectCodexBinary()).detected).toBe(false)

    mocks.locateBinary.mockResolvedValue('/opt/homebrew/bin/codex')
    mocks.runBinaryCommand.mockResolvedValue({ stdout: 'codex-cli 0.130.0\n', stderr: '' })

    expect((await detectCodexBinary()).detected).toBe(true)
  })
})

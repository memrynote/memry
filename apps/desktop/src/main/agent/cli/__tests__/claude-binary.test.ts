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

import { MIN_CLAUDE_VERSION } from '../claude-binary'

/** Fresh module instance so each test starts with an empty detection cache. */
async function loadDetector() {
  vi.resetModules()
  const mod = await import('../claude-binary')
  return mod.detectClaudeBinary
}

function installed(version: string): void {
  mocks.locateBinary.mockResolvedValue('/usr/local/bin/claude')
  mocks.runBinaryCommand.mockResolvedValue({ stdout: `${version} (Claude Code)\n`, stderr: '' })
}

describe('detectClaudeBinary', () => {
  beforeEach(() => {
    mocks.locateBinary.mockReset()
    mocks.runBinaryCommand.mockReset()
  })

  it('reports detected: false when which/where finds nothing', async () => {
    mocks.locateBinary.mockResolvedValue(null)
    const detectClaudeBinary = await loadDetector()

    const status = await detectClaudeBinary()

    expect(status.detected).toBe(false)
    expect(status.version).toBeNull()
    expect(status.meetsMinimum).toBe(false)
  })

  it('parses --version output and confirms minimum', async () => {
    installed('2.1.138')
    const detectClaudeBinary = await loadDetector()

    const status = await detectClaudeBinary()

    expect(status.detected).toBe(true)
    expect(status.version).toBe('2.1.138')
    expect(status.meetsMinimum).toBe(true)
    expect(status.minimumRequired).toBe(MIN_CLAUDE_VERSION)
  })

  it('reports detected without a version when --version fails', async () => {
    mocks.locateBinary.mockResolvedValue('/usr/local/bin/claude')
    mocks.runBinaryCommand.mockResolvedValue(null)
    const detectClaudeBinary = await loadDetector()

    const status = await detectClaudeBinary()

    expect(status.detected).toBe(true)
    expect(status.version).toBeNull()
    expect(status.meetsMinimum).toBe(false)
  })

  it('flags too-old versions', async () => {
    installed('1.5.0')
    const detectClaudeBinary = await loadDetector()

    const status = await detectClaudeBinary()

    expect(status.detected).toBe(true)
    expect(status.version).toBe('1.5.0')
    expect(status.meetsMinimum).toBe(false)
  })

  it('emits an install hint when undetected', async () => {
    mocks.locateBinary.mockResolvedValue(null)
    const detectClaudeBinary = await loadDetector()

    const status = await detectClaudeBinary()

    expect(status.installHint).toContain('claude.ai/code')
  })

  it('probes once when a usable binary is asked for repeatedly', async () => {
    installed('2.1.138')
    const detectClaudeBinary = await loadDetector()

    const first = await detectClaudeBinary()
    const second = await detectClaudeBinary()

    expect(second).toEqual(first)
    expect(mocks.locateBinary).toHaveBeenCalledTimes(1)
    expect(mocks.runBinaryCommand).toHaveBeenCalledTimes(1)
  })

  it('re-probes after a miss so installing the CLI mid-session is picked up', async () => {
    mocks.locateBinary.mockResolvedValueOnce(null)
    const detectClaudeBinary = await loadDetector()

    expect((await detectClaudeBinary()).detected).toBe(false)

    installed('2.1.138')

    expect((await detectClaudeBinary()).detected).toBe(true)
  })

  it('re-probes after an outdated binary so upgrading mid-session is picked up', async () => {
    installed('1.5.0')
    const detectClaudeBinary = await loadDetector()

    expect((await detectClaudeBinary()).meetsMinimum).toBe(false)

    installed('2.1.138')

    expect((await detectClaudeBinary()).meetsMinimum).toBe(true)
  })
})

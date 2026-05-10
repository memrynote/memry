import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }))
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return { ...actual, existsSync: vi.fn() }
})

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

import { detectClaudeBinary, MIN_CLAUDE_VERSION } from '../claude-binary'

describe('detectClaudeBinary', () => {
  beforeEach(() => {
    vi.mocked(spawnSync).mockReset()
    vi.mocked(existsSync).mockReset()
  })

  it('reports detected: false when which/where finds nothing', async () => {
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: 1,
      stdout: '',
      stderr: ''
    } as ReturnType<typeof spawnSync>)

    const status = await detectClaudeBinary()

    expect(status.detected).toBe(false)
    expect(status.version).toBeNull()
    expect(status.meetsMinimum).toBe(false)
  })

  it('parses --version output and confirms minimum', async () => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 0, stdout: '/usr/local/bin/claude\n', stderr: '' } as any)
      .mockReturnValueOnce({ status: 0, stdout: '2.1.138 (Claude Code)\n', stderr: '' } as any)
    vi.mocked(existsSync).mockReturnValue(true)

    const status = await detectClaudeBinary()

    expect(status.detected).toBe(true)
    expect(status.version).toBe('2.1.138')
    expect(status.meetsMinimum).toBe(true)
    expect(status.minimumRequired).toBe(MIN_CLAUDE_VERSION)
  })

  it('flags too-old versions', async () => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 0, stdout: '/usr/local/bin/claude\n', stderr: '' } as any)
      .mockReturnValueOnce({ status: 0, stdout: '1.5.0\n', stderr: '' } as any)
    vi.mocked(existsSync).mockReturnValue(true)

    const status = await detectClaudeBinary()

    expect(status.detected).toBe(true)
    expect(status.version).toBe('1.5.0')
    expect(status.meetsMinimum).toBe(false)
  })

  it('emits an install hint when undetected', async () => {
    vi.mocked(spawnSync).mockReturnValueOnce({ status: 1, stdout: '', stderr: '' } as any)

    const status = await detectClaudeBinary()

    expect(status.installHint).toContain('claude.ai/code')
  })
})

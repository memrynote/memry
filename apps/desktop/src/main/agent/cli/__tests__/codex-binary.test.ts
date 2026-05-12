import { spawnSync } from 'node:child_process'

import { describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }))
vi.mock('node:fs', () => ({ existsSync: vi.fn(() => true) }))

import { detectCodexBinary, MIN_CODEX_VERSION } from '../codex-binary'

describe('detectCodexBinary', () => {
  it('reports the installed codex version when it meets the minimum', async () => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 0, stdout: '/opt/homebrew/bin/codex\n', stderr: '' } as any)
      .mockReturnValueOnce({ status: 0, stdout: 'codex-cli 0.130.0\n', stderr: '' } as any)

    await expect(detectCodexBinary()).resolves.toEqual({
      detected: true,
      version: '0.130.0',
      meetsMinimum: true,
      minimumRequired: MIN_CODEX_VERSION,
      installHint: null
    })
  })

  it('surfaces install guidance when codex is missing', async () => {
    vi.mocked(spawnSync).mockReturnValueOnce({ status: 1, stdout: '', stderr: '' } as any)

    const status = await detectCodexBinary()

    expect(status.detected).toBe(false)
    expect(status.minimumRequired).toBe(MIN_CODEX_VERSION)
    expect(status.installHint).toContain('codex')
  })
})

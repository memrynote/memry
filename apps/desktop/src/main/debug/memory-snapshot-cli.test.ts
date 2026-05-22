import { describe, expect, it, vi } from 'vitest'
import {
  parseMemorySnapshotArgs,
  captureMemorySamples,
  normalizeVaultPath
} from './memory-snapshot-cli'
import type { DebugMemorySnapshot } from './memory-snapshot-types'

function snapshot(label: string, vaultPath: string): DebugMemorySnapshot {
  return {
    timestamp: `2026-05-22T00:00:00.000Z-${label}`,
    main: {
      rss: 100,
      heapUsed: 50,
      heapTotal: 75,
      external: 5,
      arrayBuffers: 2
    },
    renderer: {
      jsHeapSizeLimit: 1000,
      totalJSHeapSize: 200,
      usedJSHeapSize: 150
    },
    workers: [],
    metadata: {
      vaultPath,
      scenario: 'boot',
      branch: 'feat/test',
      label,
      hostname: 'test-host',
      capturedAt: `2026-05-22T00:00:00.000Z-${label}`
    }
  }
}

describe('parseMemorySnapshotArgs', () => {
  it('requires scenario, vault, and label', () => {
    expect(() => parseMemorySnapshotArgs(['--scenario', 'boot', '--vault', '/vault'])).toThrow(
      '--label is required'
    )
  })

  it('accepts boot and idle-60s scenarios', () => {
    expect(
      parseMemorySnapshotArgs(['--scenario', 'idle-60s', '--vault', '/vault', '--label', 'feat'])
    ).toMatchObject({
      scenario: 'idle-60s',
      vaultPath: '/vault',
      label: 'feat'
    })
  })

  it('resolves relative paths from the provided invocation cwd', () => {
    expect(
      parseMemorySnapshotArgs(
        ['--scenario', 'boot', '--vault', 'vaults/MemryA', '--label', 'feat'],
        { cwd: '/repo' }
      )
    ).toMatchObject({
      vaultPath: '/repo/vaults/MemryA'
    })
  })
})

describe('normalizeVaultPath', () => {
  it('expands home-relative vault paths', () => {
    expect(normalizeVaultPath('~/sideproject/vaults/MemryA', '/Users/test')).toBe(
      '/Users/test/sideproject/vaults/MemryA'
    )
  })
})

describe('captureMemorySamples', () => {
  it('reopens the requested vault before capturing samples', async () => {
    const client = {
      getVaultPath: vi.fn().mockResolvedValueOnce('/vault'),
      openVault: vi.fn().mockResolvedValue('/vault'),
      captureSnapshot: vi
        .fn()
        .mockResolvedValueOnce(snapshot('t0', '/vault'))
        .mockResolvedValueOnce(snapshot('t1', '/vault'))
        .mockResolvedValueOnce(snapshot('t2', '/vault'))
    }

    const result = await captureMemorySamples({
      client,
      scenario: 'boot',
      vaultPath: '/vault',
      label: 'feat',
      branch: 'feat/test',
      wait: vi.fn().mockResolvedValue(undefined)
    })

    expect(client.openVault).toHaveBeenCalledWith('/vault')
    expect(result.samples.map((sample) => sample.phase)).toEqual(['T0', 'T1', 'T2'])
  })

  it('fails when the active vault still differs after opening', async () => {
    const client = {
      getVaultPath: vi.fn().mockResolvedValue('/other'),
      openVault: vi.fn().mockResolvedValue('/other'),
      captureSnapshot: vi.fn()
    }

    await expect(
      captureMemorySamples({
        client,
        scenario: 'boot',
        vaultPath: '/vault',
        label: 'feat',
        branch: 'feat/test',
        wait: vi.fn().mockResolvedValue(undefined)
      })
    ).rejects.toThrow('Active vault mismatch')
  })
})

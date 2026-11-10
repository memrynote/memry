import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { VaultConfig } from '@memry/contracts/vault-api'
import { isExcludedPath, useIsNoteExcluded } from './excluded-notes-store'

// The store starts once per renderer: the first subscriber loads the config and wires
// `vault:config-changed`. These tests share that one start, in order.
const broadcasts: Array<(config: VaultConfig) => void> = []
vi.mocked(window.api.vault.getConfig).mockResolvedValue({
  excludePatterns: ['archive']
} as VaultConfig)
Object.assign(window.api, {
  onVaultConfigChanged: (callback: (config: VaultConfig) => void) => {
    broadcasts.push(callback)
    return () => {}
  }
})

describe('excluded-notes-store (#3530)', () => {
  // The pattern cases of main's `WatchFilter::excludes` (`vault/watch/filter.rs`), which refuses
  // the writes. A hidden name or the root attachments folder is not a pattern: the app writes
  // there (a `.journal` journal folder).
  it('decides a path by the exclude patterns as main does', () => {
    const patterns = ['node_modules', 'vendor/cache']
    for (const path of [
      'node_modules/p/readme.md',
      'a/node_modules/x.md',
      'vendor/cache/x.md',
      'a/vendor/cache/deep/x.md'
    ]) {
      expect(isExcludedPath(path, patterns), path).toBe(true)
    }
    for (const path of [
      '.journal/2025-01-02.md',
      'notes/.hidden.md',
      'attachments/a.png',
      'notes/a.md',
      'notes/attachments/b.md',
      'vendor/other.md',
      'node_modules_not.md'
    ]) {
      expect(isExcludedPath(path, patterns), path).toBe(false)
    }
  })

  it("loads the vault's patterns and follows every change", async () => {
    const archived = renderHook(() => useIsNoteExcluded('archive/old.md'))
    const kept = renderHook(() => useIsNoteExcluded('notes/new.md'))
    const none = renderHook(() => useIsNoteExcluded(null))

    await waitFor(() => expect(archived.result.current).toBe(true))
    expect(kept.result.current).toBe(false)
    expect(none.result.current).toBe(false)

    act(() => {
      for (const callback of broadcasts) callback({ excludePatterns: ['notes'] } as VaultConfig)
    })
    await waitFor(() => expect(archived.result.current).toBe(false))
    expect(kept.result.current).toBe(true)
  })
})

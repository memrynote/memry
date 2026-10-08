import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { VaultLockState } from '@memry/contracts/vault-locks-api'
import {
  isNoteLockedIn,
  lockedFolderFor,
  setVaultLock,
  useHasOwnNoteLock,
  useIsNoteLocked,
  useVaultLockState
} from './vault-locks-store'

// The store starts once per renderer: the first subscriber loads the state and
// wires `vault-locks:changed`. These tests share that one start, in order.
const broadcasts: Array<(state: VaultLockState) => void> = []
const list = vi.fn<() => Promise<VaultLockState>>()
const set = vi.fn()
list.mockResolvedValue({ notes: ['note-own'], folders: ['Archive'] })
Object.assign(window.api, {
  vaultLocks: { list, set },
  onVaultLocksChanged: (callback: (state: VaultLockState) => void) => {
    broadcasts.push(callback)
    return () => {}
  }
})

function broadcast(state: VaultLockState): void {
  act(() => {
    for (const callback of broadcasts) callback(state)
  })
}

describe('vault-locks-store (#2606)', () => {
  it('loads the locks at the first subscriber and answers per note', async () => {
    const own = renderHook(() => useIsNoteLocked('note-own', 'Notes/own.md'))
    const inFolder = renderHook(() => useIsNoteLocked('note-in', 'Archive/2026/in.md'))
    const sibling = renderHook(() => useIsNoteLocked('note-out', 'Archive 2/out.md'))
    const ownLock = renderHook(() => useHasOwnNoteLock('note-in'))

    await waitFor(() => expect(own.result.current).toBe(true))
    expect(list).toHaveBeenCalledTimes(1)
    expect(inFolder.result.current).toBe(true)
    expect(sibling.result.current).toBe(false)
    // A folder lock is not the note's own lock: the note toggle cannot undo it.
    expect(ownLock.result.current).toBe(false)
  })

  it('a day with no entry file yet counts as locked only under a locked folder', () => {
    expect(renderHook(() => useIsNoteLocked(null, 'Archive/2026-01-15.md')).result.current).toBe(
      true
    )
    expect(renderHook(() => useIsNoteLocked(null, 'Journal/2026-01-15.md')).result.current).toBe(
      false
    )
    expect(renderHook(() => useIsNoteLocked(null, null)).result.current).toBe(false)
  })

  it('follows every broadcast from main', () => {
    const state = renderHook(() => useVaultLockState())
    const locked = renderHook(() => useIsNoteLocked('note-own', 'Notes/own.md'))

    broadcast({ notes: [], folders: ['Notes'] })

    expect(state.result.current).toEqual({ notes: [], folders: ['Notes'] })
    expect(locked.result.current).toBe(true)

    broadcast({ notes: [], folders: [] })
    expect(locked.result.current).toBe(false)
  })

  it('publishes the state main returns after a lock change', async () => {
    set.mockResolvedValueOnce({ notes: ['note-new'], folders: [] })
    const ownLock = renderHook(() => useHasOwnNoteLock('note-new'))

    await act(() => setVaultLock('note', 'note-new', true))

    expect(set).toHaveBeenCalledWith({ kind: 'note', target: 'note-new', locked: true })
    expect(ownLock.result.current).toBe(true)
  })

  it('matches folder paths whatever their slashes', () => {
    const locks = { notes: [], folders: ['Work/Plans'] }

    expect(lockedFolderFor('Work\\Plans\\q1.md', locks)).toBe('Work/Plans')
    expect(lockedFolderFor('/Work/Plans/', locks)).toBe('Work/Plans')
    expect(lockedFolderFor('Work/Plans-old/q1.md', locks)).toBeNull()
    expect(isNoteLockedIn(locks, new Set(['n1']), 'n1', null)).toBe(true)
    expect(isNoteLockedIn(locks, new Set(), 'n2', undefined)).toBe(false)
  })
})

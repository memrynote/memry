import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { VaultLockState } from '@memry/contracts/vault-locks-api'
import {
  isNoteLockedIn,
  lockedFolderFor,
  setVaultLock,
  useHasOwnNoteLock,
  useIsNoteLocked,
  useIsVaultLockPending,
  useVaultLockState
} from './vault-locks-store'

// The store starts once per renderer: the first subscriber loads the state and
// wires `VaultLocksChangedEvent`. These tests share that one start, in order.
const { broadcasts, list, set } = vi.hoisted(() => ({
  broadcasts: [] as Array<(received: { payload: unknown }) => void>,
  list: vi.fn(),
  set: vi.fn()
}))
vi.mock('../../../generated/bindings', () => ({
  commands: { vaultLocksList: list, vaultLocksSet: set },
  events: {
    vaultLocksChangedEvent: {
      listen: async (handler: (received: { payload: unknown }) => void) => {
        broadcasts.push(handler)
        return () => {}
      }
    }
  }
}))
list.mockResolvedValue({ notes: ['note-own'], folders: ['Archive'] })

function broadcast(state: VaultLockState): void {
  act(() => {
    for (const handler of broadcasts) handler({ payload: state })
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

  it('follows every lock change Rust sends', () => {
    const state = renderHook(() => useVaultLockState())
    const locked = renderHook(() => useIsNoteLocked('note-own', 'Notes/own.md'))

    broadcast({ notes: [], folders: ['Notes'] })

    expect(state.result.current).toEqual({ notes: [], folders: ['Notes'] })
    expect(locked.result.current).toBe(true)

    broadcast({ notes: [], folders: [] })
    expect(locked.result.current).toBe(false)
  })

  it('publishes the state the command answers after a lock change', async () => {
    set.mockResolvedValueOnce({ notes: ['note-new'], folders: [] })
    const ownLock = renderHook(() => useHasOwnNoteLock('note-new'))

    await act(() => setVaultLock('note', 'note-new', true))

    expect(set).toHaveBeenCalledWith({ kind: 'note', target: 'note-new', locked: true })
    expect(ownLock.result.current).toBe(true)
  })

  it('an unlock of a folder no longer locked reads the locks again instead of failing', async () => {
    // Another window unlocked it first: Rust finds no lock row of that name.
    set.mockRejectedValueOnce({
      kind: 'notFound',
      code: 'folder_not_found',
      message: 'the folder is not there anymore'
    })
    list.mockResolvedValueOnce({ notes: [], folders: ['Elsewhere'] })
    const state = renderHook(() => useVaultLockState())

    await act(() => setVaultLock('folder', 'Archive', false))

    expect(state.result.current).toEqual({ notes: [], folders: ['Elsewhere'] })
  })

  it('a lock of a folder that is not there still fails', async () => {
    const notFound = {
      kind: 'notFound',
      code: 'folder_not_found',
      message: 'the folder is not there anymore'
    }
    set.mockRejectedValueOnce(notFound)

    await expect(setVaultLock('folder', 'Gone', true)).rejects.toBe(notFound)
  })

  it('holds a lock change as pending until Rust answers', async () => {
    let answer: (state: VaultLockState) => void = () => {}
    set.mockReturnValueOnce(new Promise<VaultLockState>((resolve) => (answer = resolve)))
    const pending = renderHook(() => useIsVaultLockPending('folder', 'Big'))
    const other = renderHook(() => useIsVaultLockPending('folder', 'Small'))

    let change: Promise<void> = Promise.resolve()
    act(() => {
      change = setVaultLock('folder', 'Big', true)
    })
    expect(pending.result.current).toBe(true)
    expect(other.result.current).toBe(false)
    // A second click on the same folder while it runs sends nothing more.
    await act(() => setVaultLock('folder', 'Big', true))
    expect(set).toHaveBeenCalledTimes(1)

    await act(async () => {
      answer({ notes: [], folders: ['Big'] })
      await change
    })
    expect(pending.result.current).toBe(false)
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

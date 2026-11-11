import { render, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Toast = {
  id?: string
  description?: ReactNode
  onDismiss?: () => void
  action?: { label: string; onClick: (e: Event) => void }
}

const mocks = vi.hoisted(() => ({
  vaultNoticesList: vi.fn(),
  shellRevealPath: vi.fn(),
  journalCrossIntoNotes: vi.fn(),
  listener: null as null | ((event: { payload: null }) => void),
  toast: Object.assign(vi.fn(), {
    warning: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn()
  })
}))

vi.mock('sonner', () => ({ toast: mocks.toast }))

vi.mock('../../../generated/bindings', () => ({
  commands: {
    vaultNoticesList: mocks.vaultNoticesList,
    shellRevealPath: mocks.shellRevealPath,
    journalCrossIntoNotes: mocks.journalCrossIntoNotes
  },
  events: {
    vaultNoticesChangedEvent: {
      listen: vi.fn(async (handler: (event: { payload: null }) => void) => {
        mocks.listener = handler
        return () => undefined
      })
    }
  }
}))

import { useVaultNotices, WATCH_LIMIT_COMMAND } from './use-vault-notices'

const CONFIG = { kind: 'configUnreadable', path: '/v/a/.memry/config.json' }
const LIMIT = { kind: 'watchLimit' }

/** The notices of the vault's `open`th open, as `vault_notices_list` answers. */
const listOf = (notices: unknown[], open = 1): unknown => ({ open, notices })

/**
 * The vault's notices change to `notices`: the event, then the list it reads. The hook keeps
 * what the user closed until the notice clears, so every test ends with `changeTo([])`.
 */
async function changeTo(notices: unknown[], open = 1): Promise<void> {
  const reads = mocks.vaultNoticesList.mock.calls.length
  mocks.vaultNoticesList.mockResolvedValue(listOf(notices, open))
  mocks.listener?.({ payload: null })
  await waitFor(() => expect(mocks.vaultNoticesList).toHaveBeenCalledTimes(reads + 1))
  await Promise.resolve()
}

function lastOptions(): Toast {
  return mocks.toast.warning.mock.lastCall?.[1] as Toast
}

function click(action: Toast['action']): Event {
  const event = new Event('click', { cancelable: true })
  action?.onClick(event)
  return event
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listener = null
  mocks.shellRevealPath.mockResolvedValue(null)
})

describe('useVaultNotices (#3531 14l)', () => {
  it('shows the open vault’s notice once it subscribes, and reveals the config file', async () => {
    // The open raised it before the window existed: no event reached it, the list holds it.
    mocks.vaultNoticesList.mockResolvedValue(listOf([CONFIG]))
    renderHook(() => useVaultNotices())

    await waitFor(() => expect(mocks.toast.warning).toHaveBeenCalledTimes(1))
    expect(mocks.toast.warning).toHaveBeenCalledWith(
      "Memry can't read this vault's settings",
      expect.objectContaining({
        id: 'vault-notice-configUnreadable',
        duration: Infinity,
        closeButton: true,
        description:
          "Until .memry/config.json is fixed, Memry can't turn files into notes or follow moves. " +
          'Fix the file, then restart Memry. Your notes are safe.'
      })
    )
    const event = click(lastOptions().action)
    expect(event.defaultPrevented).toBe(true)
    expect(mocks.shellRevealPath).toHaveBeenCalledWith('/v/a/.memry/config.json')
    await changeTo([])
  })

  it('copies the command that raises the Linux watch limit', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    mocks.vaultNoticesList.mockResolvedValue(listOf([LIMIT]))
    renderHook(() => useVaultNotices())

    await waitFor(() => expect(mocks.toast.warning).toHaveBeenCalledTimes(1))
    expect(mocks.toast.warning.mock.lastCall?.[0]).toBe('Changes from other apps show up late')
    expect(lastOptions().action?.label).toBe('Copy command')
    click(lastOptions().action)
    expect(writeText).toHaveBeenCalledWith(WATCH_LIMIT_COMMAND)
    await waitFor(() =>
      expect(mocks.toast.success).toHaveBeenCalledWith('Command copied. Paste it into a terminal.')
    )
    await changeTo([])
  })

  it('keeps a closed notice closed until it clears, and takes a cleared one down', async () => {
    mocks.vaultNoticesList.mockResolvedValue(listOf([CONFIG]))
    renderHook(() => useVaultNotices())
    await waitFor(() => expect(mocks.toast.warning).toHaveBeenCalledTimes(1))

    lastOptions().onDismiss?.()
    await changeTo([CONFIG, LIMIT])
    expect(mocks.toast.warning).toHaveBeenCalledTimes(2)
    expect(mocks.toast.warning.mock.lastCall?.[1]).toMatchObject({ id: 'vault-notice-watchLimit' })

    // The config reads again: its notice goes, and the watch limit's stays up.
    await changeTo([LIMIT])
    expect(mocks.toast.dismiss).toHaveBeenCalledWith('vault-notice-configUnreadable')
    expect(mocks.toast.dismiss).not.toHaveBeenCalledWith('vault-notice-watchLimit')

    // Sonner tells the taken-down toast's onDismiss; the notice raised again shows again.
    mocks.toast.warning.mock.calls[0]?.[1]?.onDismiss?.()
    await changeTo([LIMIT, CONFIG])
    expect(mocks.toast.warning).toHaveBeenLastCalledWith(
      "Memry can't read this vault's settings",
      expect.objectContaining({ id: 'vault-notice-configUnreadable' })
    )
    await changeTo([])
  })

  it('forgets what the user closed once another vault opens, or the same one again', async () => {
    mocks.vaultNoticesList.mockResolvedValue(listOf([LIMIT]))
    renderHook(() => useVaultNotices())
    await waitFor(() => expect(mocks.toast.warning).toHaveBeenCalledTimes(1))
    lastOptions().onDismiss?.()

    // The next open raised it before the window read the list: no empty list came between.
    await changeTo([LIMIT], 2)
    expect(mocks.toast.warning).toHaveBeenCalledTimes(2)
    expect(lastOptions()).toMatchObject({ id: 'vault-notice-watchLimit' })

    lastOptions().onDismiss?.()
    await changeTo([LIMIT], 2)
    expect(mocks.toast.warning).toHaveBeenCalledTimes(2)
    await changeTo([], 2)
  })

  it('lists the undecided files as the list grows, and reveals the first', async () => {
    const paths = ['/v/a/one.md', '/v/a/sub/two.md']
    mocks.vaultNoticesList.mockResolvedValue(
      listOf([{ kind: 'undecidedFiles', paths, more: false }])
    )
    renderHook(() => useVaultNotices())
    await waitFor(() => expect(mocks.toast.warning).toHaveBeenCalledTimes(1))
    expect(mocks.toast.warning.mock.lastCall?.[0]).toBe("Some files didn't become notes")
    expect(render(<>{lastOptions().description}</>).container.textContent).toContain(
      'one.md, two.md'
    )
    expect(click(lastOptions().action).defaultPrevented).toBe(true)
    expect(mocks.shellRevealPath).toHaveBeenCalledWith('/v/a/one.md')

    const grown = [...paths, '/v/a/three.md', '/v/a/four.md', '/v/a/five.md']
    await changeTo([{ kind: 'undecidedFiles', paths: grown, more: true }])
    expect(mocks.toast.warning).toHaveBeenCalledTimes(2)
    expect(lastOptions().id).toBe('vault-notice-undecidedFiles')
    expect(render(<>{lastOptions().description}</>).container.textContent).toContain(
      'one.md, two.md, three.md +2+'
    )

    // Every listed file was named, but the vault had more than it listed: no count, no reveal.
    await changeTo([{ kind: 'undecidedFiles', paths: [], more: true }])
    const text = render(<>{lastOptions().description}</>).container.textContent
    expect(text).toContain("Others aren't listed here.")
    expect(text).not.toContain('+')
    expect(lastOptions().action).toBeUndefined()
    await changeTo([])
  })

  it('lists the kept notes by name, with no action', async () => {
    const note = { noteId: 'n1', path: '/v/a/Alpha.md' }
    const day = { noteId: 'j2025-01-02', path: '/v/a/journal/2025-01-02.md' }
    mocks.vaultNoticesList.mockResolvedValue(
      listOf([{ kind: 'keptRemovals', notes: [note, day], more: false }])
    )
    renderHook(() => useVaultNotices())
    await waitFor(() => expect(mocks.toast.warning).toHaveBeenCalledTimes(1))
    expect(mocks.toast.warning.mock.lastCall?.[0]).toBe('Memry kept notes whose files were deleted')
    expect(render(<>{lastOptions().description}</>).container.textContent).toContain(
      'Alpha, 2025-01-02'
    )
    expect(lastOptions().action).toBeUndefined()
    await changeTo([])
  })

  it('names the folders journal days wait in, and reveals the first', async () => {
    const folders = ['/v/a/Diary', '/v/a/Archive/Days']
    mocks.vaultNoticesList.mockResolvedValue(listOf([{ kind: 'journalDaysHeld', folders }]))
    renderHook(() => useVaultNotices())
    await waitFor(() => expect(mocks.toast.warning).toHaveBeenCalledTimes(1))
    expect(mocks.toast.warning.mock.lastCall?.[0]).toBe(
      'Journal entries are waiting in a moved folder'
    )
    expect(lastOptions().id).toBe('vault-notice-journalDaysHeld')
    const text = render(<>{lastOptions().description}</>).container.textContent
    expect(text).toContain("the journal folder setting can't follow it yet")
    expect(text).toContain('Diary, Days')
    expect(click(lastOptions().action).defaultPrevented).toBe(true)
    expect(mocks.shellRevealPath).toHaveBeenCalledWith('/v/a/Diary')
    await changeTo([])
    expect(mocks.toast.dismiss).toHaveBeenCalledWith('vault-notice-journalDaysHeld')
  })

  it('says what holds an unfinished journal change, and reveals it', async () => {
    const change = { kind: 'journalChangeWaits', from: 'journal', to: 'Box/Diary' }
    const taken = { kind: 'taken', path: '/v/a/journal/2025-01-02.md' }
    mocks.vaultNoticesList.mockResolvedValue(listOf([{ ...change, holds: taken }]))
    renderHook(() => useVaultNotices())
    await waitFor(() => expect(mocks.toast.warning).toHaveBeenCalledTimes(1))
    expect(mocks.toast.warning.mock.lastCall?.[0]).toBe("A journal settings change didn't finish")
    const text = render(<>{lastOptions().description}</>).container.textContent
    expect(text).toContain('Another file or folder is where an entry needs to go back.')
    expect(text).toContain('2025-01-02.md')
    click(lastOptions().action)
    expect(mocks.shellRevealPath).toHaveBeenCalledWith('/v/a/journal/2025-01-02.md')

    const settings = { kind: 'settings', path: '/v/a/.memry/config.json' }
    await changeTo([{ ...change, holds: settings }])
    expect(lastOptions().description).toContain('until it can read .memry/config.json')
    click(lastOptions().action)
    expect(mocks.shellRevealPath).toHaveBeenLastCalledWith('/v/a/.memry/config.json')

    await changeTo([{ ...change, holds: { kind: 'unknown' } }])
    expect(lastOptions().description).toContain("couldn't put them back")
    expect(lastOptions().action).toBeUndefined()

    await changeTo([{ ...change, holds: { kind: 'refused' } }])
    expect(lastOptions().description).toContain("couldn't move all of them back")
    expect(lastOptions().action).toBeUndefined()
    await changeTo([])
  })

  it('lists the notes whose interrupted move waits, and reveals the first', async () => {
    const notes = [
      { noteId: 'n1', path: '/v/a/Notes/Plan.md' },
      { noteId: 'n2', path: '/v/a/Scan.pdf' }
    ]
    mocks.vaultNoticesList.mockResolvedValue(listOf([{ kind: 'movesWait', notes, more: false }]))
    renderHook(() => useVaultNotices())
    await waitFor(() => expect(mocks.toast.warning).toHaveBeenCalledTimes(1))
    expect(mocks.toast.warning.mock.lastCall?.[0]).toBe("Some notes can't be moved yet")
    const text = render(<>{lastOptions().description}</>).container.textContent
    expect(text).toContain("They can't be moved or renamed until it does.")
    expect(text).toContain('Plan, Scan.pdf')
    click(lastOptions().action)
    expect(mocks.shellRevealPath).toHaveBeenCalledWith('/v/a/Notes/Plan.md')
    await changeTo([])
  })

  it('lists the journal entries renamed away from their day, and turns them into notes', async () => {
    const days = [
      { noteId: 'j1', path: '/v/a/Diary/Trip.md' },
      { noteId: 'j2', path: '/v/a/Diary/Ideas.md' }
    ]
    mocks.journalCrossIntoNotes.mockResolvedValue({ crossed: 2 })
    mocks.vaultNoticesList.mockResolvedValue(
      listOf([{ kind: 'journalDaysRenamed', days, more: false }])
    )
    renderHook(() => useVaultNotices())
    await waitFor(() => expect(mocks.toast.warning).toHaveBeenCalledTimes(1))
    expect(mocks.toast.warning.mock.lastCall?.[0]).toBe(
      'Some journal entries no longer have a date name'
    )
    const text = render(<>{lastOptions().description}</>).container.textContent
    expect(text).toContain('Trip, Ideas')
    expect(lastOptions().action?.label).toBe('Turn into notes')
    expect(click(lastOptions().action).defaultPrevented).toBe(true)
    expect(mocks.journalCrossIntoNotes).toHaveBeenCalledWith(['j1', 'j2'])
    await Promise.resolve()
    expect(mocks.toast.error).not.toHaveBeenCalled()

    // One stayed a day (it has text its file does not): the user hears the action failed.
    mocks.journalCrossIntoNotes.mockResolvedValue({ crossed: 0 })
    await changeTo([{ kind: 'journalDaysRenamed', days: days.slice(1), more: false }])
    click(lastOptions().action)
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('Action failed'))
    expect(mocks.journalCrossIntoNotes).toHaveBeenLastCalledWith(['j2'])
    await changeTo([])
  })
})

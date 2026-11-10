import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Toast = { onDismiss?: () => void; action?: { label: string; onClick: (e: Event) => void } }

const mocks = vi.hoisted(() => ({
  vaultNoticesList: vi.fn(),
  shellRevealPath: vi.fn(),
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
    shellRevealPath: mocks.shellRevealPath
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
})

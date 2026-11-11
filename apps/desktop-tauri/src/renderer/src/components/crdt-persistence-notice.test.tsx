import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const toastFn = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({ toast: toastFn }))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

const getHealth = vi.hoisted(() => vi.fn())

const ready = vi.hoisted(() => ({ fire: () => {} }))

vi.mock('../../../generated/bindings', () => ({
  commands: { crdtGetHealth: getHealth },
  events: { crdtProviderReadyEvent: {} }
}))

vi.mock('@/services/tauri-event', () => ({
  subscribeToEvent: (_event: unknown, callback: () => void, onListening?: () => void) => {
    ready.fire = callback
    onListening?.()
    return () => {}
  }
}))

import { CrdtPersistenceNotice } from './crdt-persistence-notice'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('CrdtPersistenceNotice', () => {
  it('says nothing while the store is healthy', async () => {
    getHealth.mockResolvedValue({ persistent: true, inMemorySessions: 0 })

    render(<CrdtPersistenceNotice />)

    await waitFor(() => expect(getHealth).toHaveBeenCalled())
    expect(toastFn).not.toHaveBeenCalled()
  })

  // Notes open read-only while the database is read-only (#4190): the user is told on the first
  // such launch, not the third.
  it('says this device cannot save on the first launch over a read-only database', async () => {
    getHealth.mockResolvedValue({ persistent: false, inMemorySessions: 1 })

    render(<CrdtPersistenceNotice />)

    await waitFor(() => expect(toastFn).toHaveBeenCalledTimes(1))
    const [title, options] = toastFn.mock.calls[0] as [string, { description: string }]
    expect(title).toBe('crdt.databaseReadOnlyTitle')
    expect(options.description).toBe('crdt.databaseReadOnlyBody')
  })

  // The window may ask before its vault opens, when the host has no verdict yet:
  // the editor's ready event asks again, and the notice still shows only once.
  it('asks again when a vault becomes ready and announces once', async () => {
    getHealth.mockResolvedValueOnce({ persistent: true, inMemorySessions: 0 })
    render(<CrdtPersistenceNotice />)
    await waitFor(() => expect(getHealth).toHaveBeenCalledTimes(1))
    expect(toastFn).not.toHaveBeenCalled()

    getHealth.mockResolvedValue({ persistent: false, inMemorySessions: 1 })
    ready.fire()
    await waitFor(() => expect(toastFn).toHaveBeenCalledTimes(1))
    ready.fire()
    await waitFor(() => expect(getHealth).toHaveBeenCalledTimes(3))
    expect(toastFn).toHaveBeenCalledTimes(1)
  })

  it('stays quiet when the health query fails, rather than nagging blindly', async () => {
    getHealth.mockRejectedValue(new Error('no handler'))

    render(<CrdtPersistenceNotice />)

    await waitFor(() => expect(getHealth).toHaveBeenCalled())
    expect(toastFn).not.toHaveBeenCalled()
  })
})

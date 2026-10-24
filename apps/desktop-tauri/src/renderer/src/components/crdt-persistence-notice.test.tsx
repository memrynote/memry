import { render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const toastFn = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({ toast: toastFn }))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import { CrdtPersistenceNotice } from './crdt-persistence-notice'

const getHealth = vi.fn()
const api = window.api as unknown as { syncCrdt: { getHealth: typeof getHealth } }
const realSyncCrdt = api.syncCrdt

beforeEach(() => {
  vi.clearAllMocks()
  api.syncCrdt = { getHealth }
})

afterEach(() => {
  api.syncCrdt = realSyncCrdt
})

describe('CrdtPersistenceNotice', () => {
  it('says nothing while the store is healthy', async () => {
    getHealth.mockResolvedValue({ persistent: true, inMemorySessions: 0 })

    render(<CrdtPersistenceNotice />)

    await waitFor(() => expect(getHealth).toHaveBeenCalled())
    expect(toastFn).not.toHaveBeenCalled()
  })

  // One degraded launch is usually a store that quarantined itself and will be
  // fine next time; saying anything then is noise.
  it('stays quiet below the consecutive-session threshold', async () => {
    getHealth.mockResolvedValue({ persistent: false, inMemorySessions: 2 })

    render(<CrdtPersistenceNotice />)

    await waitFor(() => expect(getHealth).toHaveBeenCalled())
    expect(toastFn).not.toHaveBeenCalled()
  })

  it('surfaces the notice once the device has degraded for three launches', async () => {
    getHealth.mockResolvedValue({ persistent: false, inMemorySessions: 3 })

    render(<CrdtPersistenceNotice />)

    await waitFor(() => expect(toastFn).toHaveBeenCalledTimes(1))
    const [title, options] = toastFn.mock.calls[0] as [string, { description: string }]
    expect(title).toBe('crdt.persistenceDegradedTitle')
    expect(options.description).toBe('crdt.persistenceDegradedBody')
  })

  it('stays quiet when the health query fails, rather than nagging blindly', async () => {
    getHealth.mockRejectedValue(new Error('no handler'))

    render(<CrdtPersistenceNotice />)

    await waitFor(() => expect(getHealth).toHaveBeenCalled())
    expect(toastFn).not.toHaveBeenCalled()
  })
})

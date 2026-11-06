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

vi.mock('../../../generated/bindings', () => ({ commands: { crdtGetHealth: getHealth } }))

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

  // A read-only core database does not heal on the next launch, so the first one says so.
  it('surfaces the notice on the first launch whose edits are not stored', async () => {
    getHealth.mockResolvedValue({ persistent: false, inMemorySessions: 1 })

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

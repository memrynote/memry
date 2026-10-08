import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CrdtWriteBackFailedEvent } from '@memry/contracts/ipc-crdt'

const toastFn = vi.hoisted(() => ({ warning: vi.fn() }))

vi.mock('sonner', () => ({ toast: toastFn }))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, values?: Record<string, string>) =>
      values ? `${key} ${JSON.stringify(values)}` : key
  })
}))

import { WritebackFailureNotice } from './writeback-failure-notice'

type Listener = (event: CrdtWriteBackFailedEvent) => void
const api = window.api as unknown as {
  onCrdtWriteBackFailed: (listener: Listener) => () => void
}
const realSubscribe = api.onCrdtWriteBackFailed
let listener: Listener | null = null
const unsubscribe = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  listener = null
  api.onCrdtWriteBackFailed = (next) => {
    listener = next
    return unsubscribe
  }
})

afterEach(() => {
  api.onCrdtWriteBackFailed = realSubscribe
})

describe('WritebackFailureNotice', () => {
  it('names the note whose file could not be updated', () => {
    render(<WritebackFailureNotice />)

    listener?.({ noteId: 'note-1', title: 'Groceries' })

    expect(toastFn.warning).toHaveBeenCalledTimes(1)
    const [title, options] = toastFn.warning.mock.calls[0] as [
      string,
      { id: string; description: string }
    ]
    expect(title).toBe('crdt.writebackFailedTitleNamed {"title":"Groceries"}')
    expect(options.description).toBe('crdt.writebackFailedBody')
    expect(options.id).toBe('write-back-failed:note-1')
  })

  it('falls back to an unnamed title when main sends none', () => {
    render(<WritebackFailureNotice />)

    listener?.({ noteId: 'note-2' })

    expect(toastFn.warning.mock.calls[0]?.[0]).toBe('crdt.writebackFailedTitle')
  })

  it('reuses one toast per note, so a repeat replaces it instead of stacking', () => {
    render(<WritebackFailureNotice />)

    listener?.({ noteId: 'note-1', title: 'Groceries' })
    listener?.({ noteId: 'note-1', title: 'Groceries' })

    const ids = toastFn.warning.mock.calls.map((call) => (call[1] as { id: string }).id)
    expect(new Set(ids)).toEqual(new Set(['write-back-failed:note-1']))
  })

  it('stops listening when unmounted', () => {
    const { unmount } = render(<WritebackFailureNotice />)

    unmount()

    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})

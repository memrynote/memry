import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CrdtWriteBackFailedEvent } from '../../../generated/bindings'

type Listener = (event: CrdtWriteBackFailedEvent) => void

const bus = vi.hoisted(() => ({
  listener: null as ((event: { payload: unknown }) => void) | null,
  unlisten: vi.fn()
}))

vi.mock('../../../generated/bindings', () => ({
  events: {
    crdtWriteBackFailedEvent: {
      listen: (handler: (event: { payload: unknown }) => void) => {
        bus.listener = handler
        return Promise.resolve(bus.unlisten)
      }
    }
  }
}))

const toastFn = vi.hoisted(() => ({ warning: vi.fn(), dismiss: vi.fn() }))

vi.mock('sonner', () => ({ toast: toastFn }))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, values?: Record<string, string>) =>
      values ? `${key} ${JSON.stringify(values)}` : key
  })
}))

import { WritebackFailureNotice } from './writeback-failure-notice'

const listener: Listener = (event) => bus.listener?.({ payload: event })

beforeEach(() => {
  vi.clearAllMocks()
  bus.listener = null
})

describe('WritebackFailureNotice', () => {
  it('names the note whose file could not be updated', () => {
    render(<WritebackFailureNotice />)

    listener({ noteId: 'note-1', title: 'Groceries' })

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

    listener({ noteId: 'note-2', title: null })

    expect(toastFn.warning.mock.calls[0]?.[0]).toBe('crdt.writebackFailedTitle')
  })

  it('reuses one toast per note, so a repeat replaces it instead of stacking', () => {
    render(<WritebackFailureNotice />)

    listener({ noteId: 'note-1', title: 'Groceries' })
    listener({ noteId: 'note-1', title: 'Groceries' })

    const ids = toastFn.warning.mock.calls.map((call) => (call[1] as { id: string }).id)
    expect(new Set(ids)).toEqual(new Set(['write-back-failed:note-1']))
  })

  it('collapses into one notice once more than three notes fail, as a full disk does', () => {
    render(<WritebackFailureNotice />)

    for (const id of ['n1', 'n2', 'n3']) listener({ noteId: id, title: id })
    expect(toastFn.warning).toHaveBeenCalledTimes(3)
    listener({ noteId: 'n4', title: 'n4' })
    listener({ noteId: 'n5', title: 'n5' })

    const dismissed = toastFn.dismiss.mock.calls.map((call) => call[0])
    expect(new Set(dismissed)).toEqual(
      new Set(['n1', 'n2', 'n3', 'n4', 'n5'].map((id) => `write-back-failed:${id}`))
    )
    const last = toastFn.warning.mock.calls.at(-1) as [string, { id: string }]
    expect(last[0]).toBe('crdt.writebackFailedTitleMany {"count":5}')
    expect(last[1].id).toBe('write-back-failed:many')
    const perNote = toastFn.warning.mock.calls.filter(
      (call) => (call[1] as { id: string }).id !== 'write-back-failed:many'
    )
    expect(perNote).toHaveLength(3)
  })

  it('stops listening when unmounted', async () => {
    const { unmount } = render(<WritebackFailureNotice />)

    unmount()

    await vi.waitFor(() => expect(bus.unlisten).toHaveBeenCalledTimes(1))
  })
})

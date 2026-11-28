import { describe, expect, it, vi } from 'vitest'

const listeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>())
const events = vi.hoisted(() => {
  const event = (name: string) => ({
    listen: async (handler: (event: { payload: unknown }) => void) => {
      listeners.set(name, handler)
      return () => listeners.delete(name)
    }
  })
  return {
    syncAttachmentMaterializedEvent: event('materialized'),
    syncAttachmentUploadFailedEvent: event('failed')
  }
})

vi.mock('../../../generated/bindings', () => ({ events }))

import { onAttachmentMaterialized, onAttachmentUploadFailed } from './attachment-events'

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('attachment events', () => {
  it('hands the renderer Electron’s payloads', async () => {
    const materialized = vi.fn()
    const failed = vi.fn()
    onAttachmentMaterialized(materialized)
    onAttachmentUploadFailed(failed)
    await settled()

    listeners.get('materialized')?.({ payload: { noteId: 'n1' } })
    const failure = { noteId: 'n1', diskPath: '/v/attachments/n1', error: 'not found' }
    listeners.get('failed')?.({ payload: failure })

    expect(materialized).toHaveBeenCalledWith({ noteId: 'n1' })
    expect(failed).toHaveBeenCalledWith(failure)
  })
})

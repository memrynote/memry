import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createGeneratedRpcApi } from './generated-rpc'

const sampleInput = {
  id: 'id-1',
  itemId: 'inbox-1',
  itemType: 'link',
  suggestedTo: 'Notes',
  actualTo: 'Archive',
  confidence: 0.75,
  suggestedTags: ['suggested'],
  actualTags: ['actual'],
  days: 14,
  enabled: true,
  title: 'Title'
}

const attachmentBuffer = new Uint8Array([1, 2, 3]).buffer

const createFileLike = () => ({
  name: 'attachment.bin',
  arrayBuffer: vi.fn(async () => attachmentBuffer)
})

const collectFunctionPaths = (value: unknown, prefix: string[] = []): string[][] => {
  if (!value || typeof value !== 'object') return []

  const paths: string[][] = []
  for (const [key, child] of Object.entries(value)) {
    const nextPath = [...prefix, key]
    if (typeof child === 'function') {
      paths.push(nextPath)
    } else {
      paths.push(...collectFunctionPaths(child, nextPath))
    }
  }
  return paths
}

describe('createGeneratedRpcApi', () => {
  const invoke = vi.fn(async (channel: string, ...args: unknown[]) => ({ channel, args }))
  const invokeSync = vi.fn(() => ({ theme: 'white' }))
  const subscribe = vi.fn((_channel: string, callback: (payload: unknown) => void) => {
    callback({ delivered: true })
    return vi.fn()
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('routes every generated wrapper through invoke, invokeSync, or subscribe', async () => {
    const api = createGeneratedRpcApi({ invoke: invoke as any, invokeSync, subscribe }) as any
    const callback = vi.fn()

    for (const path of collectFunctionPaths(api)) {
      const fn = path.reduce((current, key) => current[key], api)
      const dotted = path.join('.')
      const args =
        dotted === 'notes.uploadAttachment'
          ? ['note-1', createFileLike()]
          : dotted.startsWith('on')
            ? [callback]
            : [sampleInput, sampleInput, sampleInput, sampleInput, sampleInput, sampleInput]

      await Promise.resolve(fn(...args))
    }

    expect(invoke).toHaveBeenCalledWith('notes:rename', {
      id: sampleInput,
      newTitle: sampleInput
    })
    expect(invoke).toHaveBeenCalledWith('notes:upload-attachment', {
      noteId: 'note-1',
      filename: 'attachment.bin',
      data: attachmentBuffer
    })
    // The ArrayBuffer crosses the IPC boundary untouched. Expanding it into a
    // number[] here is what made a large attachment cost seconds of parsing and
    // gigabytes of RSS before it ever reached the main process.
    const uploadPayload = invoke.mock.calls.find(
      (call) => call[0] === 'notes:upload-attachment'
    )?.[1] as { data: unknown } | undefined
    expect(uploadPayload?.data).toBe(attachmentBuffer)
    expect(invoke).toHaveBeenCalledWith(
      'inbox:track-suggestion',
      'inbox-1',
      'link',
      'Notes',
      'Archive',
      0.75,
      ['suggested'],
      ['actual']
    )
    expect(invoke).toHaveBeenCalledWith('tasks:get-upcoming', { days: sampleInput })
    expect(invokeSync).toHaveBeenCalledWith('settings:getStartupThemeSync')
    expect(subscribe).toHaveBeenCalledWith('notes:created', callback)
    expect(subscribe).toHaveBeenCalledWith('calendar:changed', callback)
    expect(callback).toHaveBeenCalledWith({ delivered: true })
  })

  it('normalizes startup theme sync fallbacks', () => {
    const api = createGeneratedRpcApi({ invoke: invoke as any, invokeSync, subscribe })

    invokeSync.mockReturnValueOnce('dark')
    expect(api.settings.getStartupThemeSync()).toBe('dark')

    invokeSync.mockReturnValueOnce({ theme: 'light' })
    expect(api.settings.getStartupThemeSync()).toBe('light')

    invokeSync.mockReturnValueOnce(null)
    expect(api.settings.getStartupThemeSync()).toBe('system')
  })
})

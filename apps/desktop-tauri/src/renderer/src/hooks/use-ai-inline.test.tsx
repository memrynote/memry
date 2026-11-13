import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InlineAiSettings } from '../../../generated/bindings'

type Listener = (event: { payload: { settings: InlineAiSettings } }) => void

const mocks = vi.hoisted(() => ({
  commands: { aiInlineGetSettings: vi.fn() },
  listeners: [] as Listener[],
  listen: { failure: null as Error | null },
  unlisten: vi.fn(),
  warn: vi.fn()
}))
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: mocks.warn, error: vi.fn() })
}))
vi.mock('../../../generated/bindings', () => ({
  commands: mocks.commands,
  events: {
    aiInlineSettingsChangedEvent: {
      listen: vi.fn((listener: Listener) => {
        if (mocks.listen.failure) return Promise.reject(mocks.listen.failure)
        mocks.listeners.push(listener)
        return Promise.resolve(mocks.unlisten)
      })
    }
  }
}))

import { useAIInline } from './use-ai-inline'

const settings = (enabled: boolean): InlineAiSettings => ({
  enabled,
  provider: 'openai',
  model: 'gpt-5',
  apiKey: '\u2022'.repeat(8),
  baseUrl: ''
})

beforeEach(() => {
  mocks.commands.aiInlineGetSettings.mockReset()
  mocks.listeners.length = 0
  mocks.listen.failure = null
  mocks.unlisten.mockReset()
  mocks.warn.mockReset()
})

describe('useAIInline', () => {
  it('reads nothing while AI is off globally', async () => {
    const { result } = renderHook(() => useAIInline(false))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.ready).toBe(false)
    expect(mocks.commands.aiInlineGetSettings).not.toHaveBeenCalled()
  })

  it('is ready when the inline AI settings are on, and follows their changes', async () => {
    mocks.commands.aiInlineGetSettings.mockResolvedValue(settings(true))
    const { result, unmount } = renderHook(() => useAIInline())
    await waitFor(() => expect(result.current.ready).toBe(true))

    act(() => mocks.listeners[0]?.({ payload: { settings: settings(false) } }))
    expect(result.current.ready).toBe(false)
    act(() => mocks.listeners[0]?.({ payload: { settings: settings(true) } }))
    expect(result.current.ready).toBe(true)

    unmount()
    await waitFor(() => expect(mocks.unlisten).toHaveBeenCalled())
  })

  it('logs an unsubscribe that fails on unmount', async () => {
    mocks.commands.aiInlineGetSettings.mockResolvedValue(settings(true))
    const failure = new Error('unlisten failed')
    mocks.unlisten.mockImplementation(() => {
      throw failure
    })
    const { result, unmount } = renderHook(() => useAIInline())
    await waitFor(() => expect(result.current.ready).toBe(true))

    unmount()
    await waitFor(() =>
      expect(mocks.warn).toHaveBeenCalledWith(
        'Unsubscribing from the inline AI settings failed',
        failure
      )
    )
  })

  it('logs a failed subscription once, not again on unmount', async () => {
    mocks.commands.aiInlineGetSettings.mockResolvedValue(settings(true))
    const failure = new Error('listen failed')
    mocks.listen.failure = failure
    const { result, unmount } = renderHook(() => useAIInline())
    await waitFor(() => expect(result.current.ready).toBe(true))

    unmount()
    // The unmount's cleanup settles on the same rejected subscription.
    await act(async () => {
      await Promise.resolve()
    })
    expect(mocks.warn.mock.calls).toEqual([['AI inline settings subscription failed', failure]])
  })

  it('stays off when the inline AI settings are off', async () => {
    mocks.commands.aiInlineGetSettings.mockResolvedValue(settings(false))
    const { result } = renderHook(() => useAIInline())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.ready).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('reports a failed read and reads again on retry', async () => {
    mocks.commands.aiInlineGetSettings
      .mockRejectedValueOnce({ kind: 'notFound', code: 'no_vault_open', message: 'no vault' })
      .mockResolvedValueOnce(settings(true))
    const { result } = renderHook(() => useAIInline())
    await waitFor(() => expect(result.current.error).toBe('no vault'))
    expect(result.current.ready).toBe(false)

    act(() => result.current.retry())
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.error).toBeNull()
  })
})

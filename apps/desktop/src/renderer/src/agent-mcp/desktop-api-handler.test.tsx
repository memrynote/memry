import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentMcpDesktopApiChannel } from '@memry/contracts/agent-mcp-channels'

const mocks = vi.hoisted(() => ({
  logError: vi.fn()
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: mocks.logError
  })
}))

import { useAgentMcpDesktopApiResponder } from './desktop-api-handler'

describe('useAgentMcpDesktopApiResponder', () => {
  let onMainInvokeCallback:
    | ((payload: { requestId: string; channel: string; payload?: unknown }) => void | Promise<void>)
    | undefined
  let respondToMainInvoke: ReturnType<typeof vi.fn>
  let templatesList: ReturnType<typeof vi.fn>
  let templatesCreate: ReturnType<typeof vi.fn>

  beforeEach(() => {
    onMainInvokeCallback = undefined
    respondToMainInvoke = vi.fn()
    templatesList = vi.fn().mockResolvedValue({ templates: [] })
    templatesCreate = vi.fn().mockResolvedValue({
      success: true,
      template: { id: 'template-1', name: 'Template' }
    })
    mocks.logError.mockReset()
    ;(window as Window & { api: unknown }).api = {
      onMainInvoke: vi.fn(
        (
          callback: (payload: {
            requestId: string
            channel: string
            payload?: unknown
          }) => void | Promise<void>
        ) => {
          onMainInvokeCallback = callback
          return vi.fn()
        }
      ),
      respondToMainInvoke,
      templates: {
        list: templatesList,
        create: templatesCreate
      }
    }
  })

  it('forwards allowlisted desktop read operations to window.api', async () => {
    renderHook(() => useAgentMcpDesktopApiResponder())
    await waitFor(() => expect(window.api.onMainInvoke).toHaveBeenCalled())

    await onMainInvokeCallback?.({
      requestId: 'request-1',
      channel: AgentMcpDesktopApiChannel,
      payload: { operation: 'templates.list', args: [] }
    })

    expect(templatesList).toHaveBeenCalledWith()
    expect(respondToMainInvoke).toHaveBeenCalledWith('request-1', {
      ok: true,
      data: { templates: [] }
    })
  })

  it('does not subscribe when disabled', () => {
    renderHook(() => useAgentMcpDesktopApiResponder({ enabled: false }))

    expect(window.api.onMainInvoke).not.toHaveBeenCalled()
  })

  it('forwards allowlisted desktop write operations with args', async () => {
    renderHook(() => useAgentMcpDesktopApiResponder())
    await waitFor(() => expect(window.api.onMainInvoke).toHaveBeenCalled())

    await onMainInvokeCallback?.({
      requestId: 'request-2',
      channel: AgentMcpDesktopApiChannel,
      payload: { operation: 'templates.create', args: [{ name: 'Template' }] }
    })

    expect(templatesCreate).toHaveBeenCalledWith({ name: 'Template' })
    expect(respondToMainInvoke).toHaveBeenCalledWith('request-2', {
      ok: true,
      data: {
        success: true,
        template: { id: 'template-1', name: 'Template' }
      }
    })
  })

  it('rejects operations outside the desktop CRUD allowlist', async () => {
    renderHook(() => useAgentMcpDesktopApiResponder())
    await waitFor(() => expect(window.api.onMainInvoke).toHaveBeenCalled())

    await onMainInvokeCallback?.({
      requestId: 'request-3',
      channel: AgentMcpDesktopApiChannel,
      payload: { operation: 'account.signOut', args: [] }
    })

    expect(respondToMainInvoke).toHaveBeenCalledWith('request-3', {
      ok: false,
      error: { code: 'VALIDATION', message: 'Invalid desktop API request.' }
    })
  })

  it('ignores unrelated main invoke channels', async () => {
    renderHook(() => useAgentMcpDesktopApiResponder())
    await waitFor(() => expect(window.api.onMainInvoke).toHaveBeenCalled())

    await onMainInvokeCallback?.({
      requestId: 'request-ignore',
      channel: 'other-channel',
      payload: { operation: 'templates.list', args: [] }
    })

    expect(templatesList).not.toHaveBeenCalled()
    expect(respondToMainInvoke).not.toHaveBeenCalled()
  })

  it('returns a desktop API error when an allowlisted operation is unavailable', async () => {
    renderHook(() => useAgentMcpDesktopApiResponder())
    await waitFor(() => expect(window.api.onMainInvoke).toHaveBeenCalled())

    await onMainInvokeCallback?.({
      requestId: 'request-4',
      channel: AgentMcpDesktopApiChannel,
      payload: { operation: 'bookmarks.list', args: [] }
    })

    expect(respondToMainInvoke).toHaveBeenCalledWith('request-4', {
      ok: false,
      error: {
        code: 'DESKTOP_API_ERROR',
        message: 'Desktop API operation is unavailable: bookmarks.list'
      }
    })
    expect(mocks.logError).toHaveBeenCalled()
  })

  it('returns a desktop API error when an allowlisted operation is not callable', async () => {
    ;(window.api.templates as Record<string, unknown>).list = []

    renderHook(() => useAgentMcpDesktopApiResponder())
    await waitFor(() => expect(window.api.onMainInvoke).toHaveBeenCalled())

    await onMainInvokeCallback?.({
      requestId: 'request-5',
      channel: AgentMcpDesktopApiChannel,
      payload: { operation: 'templates.list', args: [] }
    })

    expect(respondToMainInvoke).toHaveBeenCalledWith('request-5', {
      ok: false,
      error: {
        code: 'DESKTOP_API_ERROR',
        message: 'Desktop API operation is not callable: templates.list'
      }
    })
    expect(mocks.logError).toHaveBeenCalled()
  })
})

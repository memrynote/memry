import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '@/contexts/tabs'

const mocks = vi.hoisted(() => ({
  useActiveTab: vi.fn(),
  extractMarkdownFromActiveEditor: vi.fn()
}))

vi.mock('@/contexts/tabs', () => ({
  useActiveTab: () => mocks.useActiveTab()
}))

vi.mock('@/components/note/content-area/hooks/use-editor-sync', () => ({
  extractMarkdownFromActiveEditor: (...args: [string?]) =>
    mocks.extractMarkdownFromActiveEditor(...args)
}))

import { useAgentMcpCurrentNoteResponder } from './current-note-handler'

describe('useAgentMcpCurrentNoteResponder', () => {
  let onMainInvokeCallback:
    | ((payload: { requestId: string; channel: string; payload?: unknown }) => void | Promise<void>)
    | undefined
  let respondToMainInvoke: ReturnType<typeof vi.fn>

  beforeEach(() => {
    onMainInvokeCallback = undefined
    respondToMainInvoke = vi.fn()
    mocks.useActiveTab.mockReset()
    mocks.extractMarkdownFromActiveEditor.mockReset()

    window.api.onMainInvoke = vi.fn(
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
    )
    window.api.respondToMainInvoke = respondToMainInvoke
  })

  it('responds with the active note markdown snapshot', async () => {
    mocks.useActiveTab.mockReturnValue({
      type: 'note',
      entityId: 'note-1',
      title: 'Today'
    } as Tab)
    mocks.extractMarkdownFromActiveEditor.mockResolvedValue('# Today')

    renderHook(() => useAgentMcpCurrentNoteResponder())
    await waitFor(() => expect(window.api.onMainInvoke).toHaveBeenCalled())

    await onMainInvokeCallback?.({
      requestId: 'request-1',
      channel: 'agent_mcp:get_current_note'
    })

    expect(mocks.extractMarkdownFromActiveEditor).toHaveBeenCalledWith('note-1')
    expect(respondToMainInvoke).toHaveBeenCalledWith('request-1', {
      id: 'note-1',
      title: 'Today',
      content_markdown: '# Today',
      tags: []
    })
  })

  it('responds null when the active tab is not a note', async () => {
    mocks.useActiveTab.mockReturnValue({ type: 'journal', title: 'Journal' } as Tab)

    renderHook(() => useAgentMcpCurrentNoteResponder())
    await waitFor(() => expect(window.api.onMainInvoke).toHaveBeenCalled())

    await onMainInvokeCallback?.({
      requestId: 'request-2',
      channel: 'agent_mcp:get_current_note'
    })

    expect(mocks.extractMarkdownFromActiveEditor).not.toHaveBeenCalled()
    expect(respondToMainInvoke).toHaveBeenCalledWith('request-2', null)
  })
})

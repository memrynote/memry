import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentReviewTarget } from '@memry/contracts/ipc-agent'

import { useAgentBodyReview } from './use-agent-body-review'

const mocks = vi.hoisted(() => ({
  approveTool: vi.fn(async () => undefined),
  pendingApprovals: [] as unknown[],
  noteListeners: [] as ((event: { id: string }) => void)[],
  previewDiff: vi.fn(),
  t: (key: string) => key
}))

vi.mock('@memry/i18n/renderer', () => ({ useT: () => ({ t: mocks.t }) }))

vi.mock('@/agent-chat/agent-context', () => ({
  useAgentOptional: () => ({
    state: { pendingApprovals: mocks.pendingApprovals },
    approveTool: mocks.approveTool
  })
}))

vi.mock('@/lib/save-registry', () => ({ flushAllPendingSaves: async () => undefined }))

vi.mock('@/services/notes-service', () => ({
  onNoteUpdated: (listener: (event: { id: string }) => void) => {
    mocks.noteListeners.push(listener)
    return () => undefined
  }
}))

vi.mock('@/services/journal-service', () => ({
  onJournalEntryUpdated: () => () => undefined,
  onJournalExternalChange: () => () => undefined
}))

const target: AgentReviewTarget = { kind: 'note', id: 'note-1' }

const pending = {
  kind: 'tool_call_pending_approval',
  conversationId: 'conversation-1',
  toolCallId: 'gate-1',
  name: 'vault_update_note',
  args: { id: 'note-1', mode: 'append', content_markdown: 'Added' },
  requiresDiff: true,
  previewKind: 'body',
  reviewTarget: target
}

function previewFor(current: string, candidate: string) {
  return {
    title: 'Weekly plan',
    current,
    candidate,
    preview: {
      kind: 'body',
      item: { type: 'note', id: 'note-1', title: 'Weekly plan', context: null },
      intent: 'update',
      fields: [],
      body: { current, candidate },
      loss: [],
      destructive: false
    }
  }
}

beforeEach(() => {
  mocks.pendingApprovals = [pending]
  mocks.noteListeners = []
  mocks.approveTool.mockClear()
  mocks.previewDiff.mockReset()
  mocks.previewDiff.mockResolvedValue(previewFor('Old', 'Old\nAdded'))
  ;(window as unknown as { api: unknown }).api = { agent: { previewDiff: mocks.previewDiff } }
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useAgentBodyReview', () => {
  it('stays idle when nothing is pending for the page', () => {
    mocks.pendingApprovals = []
    const { result } = renderHook(() => useAgentBodyReview(target))
    expect(result.current).toBeNull()
  })

  it('loads the preview and accepts it unchanged as a plain allow', async () => {
    const { result } = renderHook(() => useAgentBodyReview(target))

    await waitFor(() => expect(result.current?.candidate).toBe('Old\nAdded'))
    expect(result.current?.title).toBe('Weekly plan')
    expect(result.current?.changeCount).toBe(1)

    await act(() => result.current!.accept())

    expect(mocks.approveTool).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      toolCallId: 'gate-1',
      decision: { kind: 'allow' }
    })
  })

  it('accepts an edited draft as a full replace of the note', async () => {
    const { result } = renderHook(() => useAgentBodyReview(target))
    await waitFor(() => expect(result.current?.candidate).toBe('Old\nAdded'))

    act(() => {
      result.current!.startEdit()
      result.current!.setDraft('Old\nAdded, then edited')
    })
    await act(() => result.current!.accept())

    expect(mocks.approveTool).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      toolCallId: 'gate-1',
      decision: {
        kind: 'edit_allow',
        editedArgs: { id: 'note-1', mode: 'replace', content_markdown: 'Old\nAdded, then edited' }
      }
    })
  })

  it('rejects as a deny', async () => {
    const { result } = renderHook(() => useAgentBodyReview(target))
    await waitFor(() => expect(result.current?.candidate).not.toBeNull())

    await act(() => result.current!.reject())

    expect(mocks.approveTool).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      toolCallId: 'gate-1',
      decision: { kind: 'deny' }
    })
  })

  it('re-reads the preview when the note changes, and flags a draft left behind', async () => {
    const { result } = renderHook(() => useAgentBodyReview(target))
    await waitFor(() => expect(result.current?.current).toBe('Old'))

    act(() => {
      result.current!.startEdit()
      result.current!.setDraft('My draft')
    })

    mocks.previewDiff.mockResolvedValue(previewFor('Changed elsewhere', 'Changed elsewhere\nAdded'))
    act(() => {
      for (const listener of mocks.noteListeners) listener({ id: 'note-1' })
    })

    await waitFor(() => expect(result.current?.current).toBe('Changed elsewhere'))
    expect(result.current?.baseChanged).toBe(true)
    expect(result.current?.draft).toBe('My draft')

    act(() => result.current!.restartFromLatest())

    expect(result.current?.baseChanged).toBe(false)
    expect(result.current?.draft).toBeNull()
    expect(result.current?.candidate).toBe('Changed elsewhere\nAdded')
  })
})

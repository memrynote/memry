import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import type React from 'react'

const { AIExtensionMock, DefaultChatTransportMock } = vi.hoisted(() => ({
  AIExtensionMock: vi.fn((config: unknown) => ({ name: 'ai', config })),
  DefaultChatTransportMock: vi.fn(function DefaultChatTransport(config: unknown) {
    return config
  })
}))

vi.mock('@blocknote/xl-ai', () => ({
  AIExtension: AIExtensionMock
}))

vi.mock('ai', () => ({
  DefaultChatTransport: DefaultChatTransportMock
}))

import { useBlockNoteSetup } from './use-block-note-setup'

function createEditor(options?: { registerCreatesExtension?: boolean }) {
  let aiExtension: unknown = null
  const registerCreatesExtension = options?.registerCreatesExtension ?? true

  const editor = {
    getExtension: vi.fn((name: string) => (name === 'ai' ? aiExtension : null)),
    registerExtension: vi.fn((extension: unknown) => {
      if (registerCreatesExtension) {
        aiExtension = extension
      }
    }),
    unregisterExtension: vi.fn((name: string) => {
      if (name === 'ai') {
        aiExtension = null
      }
    }),
    focus: vi.fn(),
    document: []
  }

  return { editor, getAIExtension: () => aiExtension }
}

describe('useBlockNoteSetup', () => {
  let editorContainerRef: React.RefObject<HTMLDivElement | null>

  beforeEach(() => {
    vi.clearAllMocks()
    editorContainerRef = { current: document.createElement('div') }
  })

  it('keeps aiReady false until the editor exposes the ai extension', async () => {
    const { editor } = createEditor({ registerCreatesExtension: false })

    const { result } = renderHook(() =>
      useBlockNoteSetup({
        editor,
        aiPort: 4315,
        editorContainerRef
      })
    )

    await waitFor(() => {
      expect(editor.registerExtension).toHaveBeenCalledTimes(1)
    })

    expect(result.current.aiReady).toBe(false)
  })

  it('marks aiReady true after registering the ai extension', async () => {
    const { editor, getAIExtension } = createEditor()

    const { result, unmount } = renderHook(() =>
      useBlockNoteSetup({
        editor,
        aiPort: 4315,
        editorContainerRef
      })
    )

    await waitFor(() => {
      expect(result.current.aiReady).toBe(true)
    })

    expect(DefaultChatTransportMock).toHaveBeenCalledWith({
      api: 'http://127.0.0.1:4315/api/ai/chat'
    })
    expect(AIExtensionMock).toHaveBeenCalledTimes(1)
    expect(getAIExtension()).toBeTruthy()

    unmount()

    expect(editor.unregisterExtension).toHaveBeenCalledWith('ai')
  })
})

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useWikiLinkSuggestions } from './use-wiki-link-suggestions'

const mocks = vi.hoisted(() => ({
  listNotes: vi.fn(),
  getFile: vi.fn(),
  logger: {
    error: vi.fn()
  }
}))

vi.mock('@/services/notes-service', () => ({
  notesService: {
    list: (...args: unknown[]) => mocks.listNotes(...args),
    getFile: (...args: unknown[]) => mocks.getFile(...args)
  }
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => mocks.logger
}))

describe('useWikiLinkSuggestions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-10T12:00:00.000Z'))
    mocks.listNotes.mockResolvedValue({
      notes: [
        { id: 'note-1', title: 'Daily Note', modified: new Date('2026-05-09T00:00:00.000Z') },
        { id: 'note-2', title: 'Roadmap', modified: '2026-05-08T00:00:00.000Z' }
      ]
    })
  })

  it('loads, caches, filters, aliases, and creates missing wiki-link suggestions', async () => {
    const editor = { insertInlineContent: vi.fn() }
    const { result } = renderHook(() => useWikiLinkSuggestions(editor))

    let exact = [] as Awaited<ReturnType<typeof result.current.getWikiLinkItems>>
    await act(async () => {
      exact = await result.current.getWikiLinkItems('Daily Note | today')
    })
    expect(mocks.listNotes).toHaveBeenCalledWith({ limit: 500, sortBy: 'modified' })
    expect(exact).toEqual([
      {
        id: 'note-1',
        title: 'Daily Note',
        target: 'Daily Note',
        alias: 'today',
        exists: true,
        type: 'note',
        lastEdited: '2026-05-09T00:00:00.000Z'
      }
    ])

    let missing = [] as Awaited<ReturnType<typeof result.current.getWikiLinkItems>>
    await act(async () => {
      missing = await result.current.getWikiLinkItems('Missing | alias')
    })
    expect(mocks.listNotes).toHaveBeenCalledTimes(1)
    expect(missing).toEqual([
      {
        id: 'create:Missing',
        title: 'Missing',
        target: 'Missing',
        alias: 'alias',
        exists: false,
        type: 'create'
      }
    ])

    act(() => {
      result.current.handleWikiLinkSelect(missing[0])
      result.current.handleWikiLinkSelect({ ...missing[0], target: '' })
    })
    expect(editor.insertInlineContent).toHaveBeenNthCalledWith(
      1,
      [{ type: 'wikiLink', props: { target: 'Missing', alias: 'alias' } }],
      { updateSelection: true }
    )
    expect(editor.insertInlineContent).toHaveBeenNthCalledWith(2, [' '], { updateSelection: true })
    expect(editor.insertInlineContent).toHaveBeenCalledTimes(2)
  })

  it('embeds audio wiki-link suggestions as playable file blocks', async () => {
    mocks.listNotes.mockResolvedValueOnce({
      notes: [
        {
          id: 'voice-1',
          title: 'Voice memo',
          modified: '2026-05-10T11:00:00.000Z',
          fileType: 'audio',
          mimeType: 'audio/wav',
          fileSize: 4096
        }
      ]
    })
    mocks.getFile.mockResolvedValueOnce({
      id: 'voice-1',
      absolutePath: '/Users/kaan/vault/notes/Voice memo.wav',
      title: 'Voice memo',
      fileType: 'audio',
      mimeType: 'audio/wav',
      fileSize: 4096
    })

    const currentBlock = { id: 'block-1', type: 'paragraph', content: [] }
    const editor = {
      insertInlineContent: vi.fn(),
      getTextCursorPosition: vi.fn(() => ({ block: currentBlock })),
      getBlock: vi.fn(() => currentBlock),
      updateBlock: vi.fn(),
      insertBlocks: vi.fn()
    }
    const { result } = renderHook(() => useWikiLinkSuggestions(editor))

    let suggestions = [] as Awaited<ReturnType<typeof result.current.getWikiLinkItems>>
    await act(async () => {
      suggestions = await result.current.getWikiLinkItems('Voice')
    })

    expect(suggestions[0]).toMatchObject({
      id: 'voice-1',
      title: 'Voice memo',
      target: 'Voice memo',
      fileType: 'audio',
      mimeType: 'audio/wav',
      fileSize: 4096
    })

    await act(async () => {
      await result.current.handleWikiLinkSelect({ ...suggestions[0], insertMode: 'embed' })
    })

    expect(mocks.getFile).toHaveBeenCalledWith('voice-1')
    expect(editor.updateBlock).toHaveBeenCalledWith(currentBlock, {
      type: 'file',
      props: {
        url: 'memry-file://local/Users/kaan/vault/notes/Voice memo.wav',
        name: 'Voice memo',
        size: 4096,
        mimeType: 'audio/wav'
      }
    })
    expect(editor.insertInlineContent).not.toHaveBeenCalled()
    expect(editor.insertBlocks).not.toHaveBeenCalled()
  })

  it('refreshes stale cache and falls back to create suggestions on list failures', async () => {
    const editor = { insertInlineContent: vi.fn() }
    const { result } = renderHook(() => useWikiLinkSuggestions(editor))

    await act(async () => {
      await result.current.getWikiLinkItems('')
    })
    vi.setSystemTime(new Date('2026-05-10T12:00:06.000Z'))
    mocks.listNotes.mockRejectedValueOnce(new Error('notes failed'))

    let suggestions = [] as Awaited<ReturnType<typeof result.current.getWikiLinkItems>>
    await act(async () => {
      suggestions = await result.current.getWikiLinkItems('Fresh')
    })

    expect(mocks.listNotes).toHaveBeenCalledTimes(2)
    expect(mocks.logger.error).toHaveBeenCalledWith(
      'Failed to load wiki link suggestions',
      expect.any(Error)
    )
    expect(suggestions).toEqual([
      {
        id: 'create:Fresh',
        title: 'Fresh',
        target: 'Fresh',
        alias: '',
        exists: false,
        type: 'create'
      }
    ])
  })
})

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useWikiLinkSuggestions } from './use-wiki-link-suggestions'

const mocks = vi.hoisted(() => ({
  listNotes: vi.fn(),
  getFile: vi.fn(),
  getByPath: vi.fn(),
  logger: {
    error: vi.fn()
  }
}))

vi.mock('@/services/notes-service', () => ({
  notesService: {
    list: (...args: unknown[]) => mocks.listNotes(...args),
    getFile: (...args: unknown[]) => mocks.getFile(...args),
    getByPath: (...args: unknown[]) => mocks.getByPath(...args)
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
        {
          id: 'note-1',
          title: 'Daily Note',
          path: 'notes/Daily Note.md',
          modified: new Date('2026-05-09T00:00:00.000Z')
        },
        {
          id: 'note-2',
          title: 'Roadmap',
          path: 'notes/Roadmap.md',
          modified: '2026-05-08T00:00:00.000Z'
        }
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
        url: 'memry-file://local/Users/kaan/vault/notes/Voice%20memo.wav',
        name: 'Voice memo',
        size: 4096,
        mimeType: 'audio/wav'
      }
    })
    expect(editor.insertInlineContent).not.toHaveBeenCalled()
    expect(editor.insertBlocks).not.toHaveBeenCalled()
  })

  describe('# heading mode', () => {
    const body = [
      '# Daily Note',
      '',
      '## **Kararlar** alındı',
      '',
      '```md',
      '## not a heading',
      '```',
      '',
      '### Sonraki adımlar'
    ].join('\n')

    it('lists the target note headings once the note half matches exactly', async () => {
      mocks.getByPath.mockResolvedValue({ content: body })
      const { result } = renderHook(() => useWikiLinkSuggestions({ insertInlineContent: vi.fn() }))

      let items = [] as Awaited<ReturnType<typeof result.current.getWikiLinkItems>>
      await act(async () => {
        items = await result.current.getWikiLinkItems('Daily Note#')
      })

      // By path, so the id lookup's `note_opened` telemetry never fires.
      expect(mocks.getByPath).toHaveBeenCalledWith('notes/Daily Note.md')
      expect(items).toEqual([
        {
          id: 'heading:note-1:0',
          title: 'Daily Note',
          target: 'Daily Note#Daily Note',
          alias: '',
          exists: true,
          type: 'heading',
          headingLevel: 1
        },
        {
          id: 'heading:note-1:1',
          title: 'Kararlar alındı',
          target: 'Daily Note#Kararlar alındı',
          alias: '',
          exists: true,
          type: 'heading',
          headingLevel: 2
        },
        {
          id: 'heading:note-1:2',
          title: 'Sonraki adımlar',
          target: 'Daily Note#Sonraki adımlar',
          alias: '',
          exists: true,
          type: 'heading',
          headingLevel: 3
        }
      ])
    })

    it('filters headings, keeps the alias, and caches the body for 5 seconds', async () => {
      mocks.getByPath.mockResolvedValue({ content: body })
      const { result } = renderHook(() => useWikiLinkSuggestions({ insertInlineContent: vi.fn() }))

      let items = [] as Awaited<ReturnType<typeof result.current.getWikiLinkItems>>
      await act(async () => {
        await result.current.getWikiLinkItems('Daily Note#')
        items = await result.current.getWikiLinkItems('Daily Note#Kararlar|dün')
      })

      expect(mocks.getByPath).toHaveBeenCalledTimes(1)
      expect(items).toEqual([
        {
          id: 'heading:note-1:0',
          title: 'Kararlar alındı',
          target: 'Daily Note#Kararlar alındı',
          alias: 'dün',
          exists: true,
          type: 'heading',
          headingLevel: 2
        }
      ])
    })

    it('keeps listing notes while the note half is only a prefix', async () => {
      const { result } = renderHook(() => useWikiLinkSuggestions({ insertInlineContent: vi.fn() }))

      let items = [] as Awaited<ReturnType<typeof result.current.getWikiLinkItems>>
      await act(async () => {
        items = await result.current.getWikiLinkItems('Daily#')
      })

      expect(mocks.getByPath).not.toHaveBeenCalled()
      expect(items.map((item) => item.type)).toEqual(['create'])
      // The row names the note that would actually be created, and the trailing
      // `#` — a half-typed separator, not a heading — is dropped rather than
      // written into the link as `[[Daily#]]`.
      expect(items[0]).toMatchObject({ title: 'Daily', target: 'Daily' })
    })

    it('keeps a real heading on the create row while naming only the note', async () => {
      const { result } = renderHook(() => useWikiLinkSuggestions({ insertInlineContent: vi.fn() }))

      let items = [] as Awaited<ReturnType<typeof result.current.getWikiLinkItems>>
      await act(async () => {
        items = await result.current.getWikiLinkItems('Daily#Standup')
      })

      expect(items.map((item) => item.type)).toEqual(['create'])
      expect(items[0]).toMatchObject({ title: 'Daily', target: 'Daily#Standup' })
    })

    it('does not offer headings for a block reference', async () => {
      const { result } = renderHook(() => useWikiLinkSuggestions({ insertInlineContent: vi.fn() }))

      await act(async () => {
        await result.current.getWikiLinkItems('Daily Note#^abc123')
      })

      expect(mocks.getByPath).not.toHaveBeenCalled()
    })

    it('says so when the note has no headings, and when none match', async () => {
      mocks.getByPath.mockResolvedValue({ content: 'Just a paragraph.' })
      const { result } = renderHook(() => useWikiLinkSuggestions({ insertInlineContent: vi.fn() }))

      let empty = [] as Awaited<ReturnType<typeof result.current.getWikiLinkItems>>
      await act(async () => {
        empty = await result.current.getWikiLinkItems('Daily Note#')
      })
      expect(empty).toEqual([
        {
          id: 'headings:note-1',
          title: 'Daily Note',
          target: '',
          alias: '',
          exists: true,
          type: 'headingEmpty',
          filtered: false
        }
      ])

      vi.setSystemTime(new Date('2026-05-10T12:00:06.000Z'))
      mocks.getByPath.mockResolvedValue({ content: body })

      let noMatch = [] as Awaited<ReturnType<typeof result.current.getWikiLinkItems>>
      await act(async () => {
        noMatch = await result.current.getWikiLinkItems('Daily Note#zzz')
      })
      expect(noMatch).toEqual([
        {
          id: 'headings:note-1',
          title: 'Daily Note',
          target: '',
          alias: '',
          exists: true,
          type: 'headingEmpty',
          filtered: true
        }
      ])
    })

    it('logs and shows the empty row when the body cannot be read', async () => {
      mocks.getByPath.mockRejectedValueOnce(new Error('read failed'))
      const { result } = renderHook(() => useWikiLinkSuggestions({ insertInlineContent: vi.fn() }))

      let items = [] as Awaited<ReturnType<typeof result.current.getWikiLinkItems>>
      await act(async () => {
        items = await result.current.getWikiLinkItems('Daily Note#')
      })

      expect(mocks.logger.error).toHaveBeenCalledWith(
        'Failed to load wiki link heading suggestions',
        expect.any(Error)
      )
      expect(items).toEqual([expect.objectContaining({ type: 'headingEmpty' })])
    })

    it('inserts one wiki link node carrying the note#heading target', async () => {
      mocks.getByPath.mockResolvedValue({ content: body })
      const editor = { insertInlineContent: vi.fn() }
      const { result } = renderHook(() => useWikiLinkSuggestions(editor))

      let items = [] as Awaited<ReturnType<typeof result.current.getWikiLinkItems>>
      await act(async () => {
        items = await result.current.getWikiLinkItems('Daily Note#Kararlar|dün')
      })
      await act(async () => {
        await result.current.handleWikiLinkSelect(items[0])
      })

      expect(editor.insertInlineContent).toHaveBeenNthCalledWith(
        1,
        [{ type: 'wikiLink', props: { target: 'Daily Note#Kararlar alındı', alias: 'dün' } }],
        { updateSelection: true }
      )
    })
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

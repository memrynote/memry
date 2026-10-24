import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { TagSuggestionPopover } from './tag-suggestion-popover'

const mocks = vi.hoisted(() => ({
  getTags: vi.fn(),
  logError: vi.fn()
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key.split('.').at(-1) ?? key })
}))

vi.mock('@/services/notes-service', () => ({
  notesService: { getTags: mocks.getTags }
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: mocks.logError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() })
}))

type HandlerName = 'selectionUpdate' | 'update'

function makeContainer(tagName = 'wo') {
  const container = document.createElement('div')
  const pill = document.createElement('span')
  pill.className = 'inline-hash-tag'
  pill.dataset.hashTag = tagName
  pill.getBoundingClientRect = vi.fn(
    () => ({ top: 20, bottom: 40, left: 60, height: 20 }) as DOMRect
  )
  container.getBoundingClientRect = vi.fn(() => ({ top: 10, left: 20 }) as DOMRect)
  container.append(pill)
  return container
}

function makeEditor(tagName = 'wo') {
  const handlers = new Map<HandlerName, () => void>()
  const selection = {
    $from: {
      parentOffset: 2,
      pos: 10,
      nodeBefore: {
        type: { name: 'hashTag' },
        attrs: { tag: tagName },
        nodeSize: 4
      }
    },
    from: 10,
    to: 10
  }

  const editor = {
    _tiptapEditor: {
      state: { selection },
      on: vi.fn((event: HandlerName, handler: () => void) => handlers.set(event, handler)),
      off: vi.fn((event: HandlerName) => handlers.delete(event))
    }
  }

  return { editor, handlers, selection }
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve()
  })
}

describe('TagSuggestionPopover', () => {
  beforeEach(() => {
    mocks.getTags.mockResolvedValue([
      { tag: 'work', color: 'blue', count: 4 },
      { tag: 'workflow', color: 'green', count: 8 },
      { tag: 'homework', color: 'red', count: 20 },
      { tag: 'wo', color: 'stone', count: 1 }
    ])
    mocks.logError.mockClear()
  })

  it('shows matching tags and supports keyboard, hover, click, and cleanup', async () => {
    const onSelect = vi.fn()
    const { editor, handlers } = makeEditor()
    const container = makeContainer()

    const { unmount } = render(
      <TagSuggestionPopover
        editor={editor}
        editorContainerRef={{ current: container }}
        onSelect={onSelect}
      />
    )

    act(() => {
      handlers.get('selectionUpdate')?.()
    })

    expect(await screen.findByRole('listbox', { name: 'aria' })).toBeInTheDocument()
    expect(screen.getByText('#workflow')).toBeInTheDocument()
    expect(screen.getByText('#work')).toBeInTheDocument()

    fireEvent.mouseEnter(screen.getByText('#work'))
    fireEvent.click(screen.getByText('#work'))
    expect(onSelect).toHaveBeenCalledWith('work', 'blue', 6)

    act(() => {
      handlers.get('update')?.()
    })
    expect(await screen.findByText('#workflow')).toBeInTheDocument()

    await flushEffects()
    fireEvent.keyDown(document, { key: 'ArrowDown' })
    fireEvent.keyDown(document, { key: 'Enter' })
    expect(onSelect).toHaveBeenLastCalledWith('work', 'blue', 6)

    unmount()
    expect(editor._tiptapEditor.off).toHaveBeenCalledWith('selectionUpdate', expect.any(Function))
    expect(editor._tiptapEditor.off).toHaveBeenCalledWith('update', expect.any(Function))
  })

  it('hides when selection is invalid, closes on escape, and logs fetch failures', async () => {
    const onSelect = vi.fn()
    const { editor, handlers, selection } = makeEditor('zz')

    render(
      <TagSuggestionPopover
        editor={editor}
        editorContainerRef={{ current: makeContainer('wo') }}
        onSelect={onSelect}
      />
    )

    act(() => {
      handlers.get('selectionUpdate')?.()
    })
    await waitFor(() => {
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    })

    selection.$from.nodeBefore = {
      type: { name: 'hashTag' },
      attrs: { tag: 'wo' },
      nodeSize: 4
    }
    act(() => {
      handlers.get('selectionUpdate')?.()
    })
    expect(await screen.findByRole('listbox')).toBeInTheDocument()

    await flushEffects()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    })

    mocks.getTags.mockRejectedValueOnce(new Error('offline'))
    const failed = makeEditor('wo')
    render(
      <TagSuggestionPopover
        editor={failed.editor}
        editorContainerRef={{ current: makeContainer('wo') }}
        onSelect={onSelect}
      />
    )
    act(() => {
      failed.handlers.get('selectionUpdate')?.()
    })

    await waitFor(() => {
      expect(mocks.logError).toHaveBeenCalledWith('Failed to fetch tags', expect.any(Error))
    })
  })

  it('does not open without a hash-tag cursor or tiptap editor', () => {
    const { editor, handlers, selection } = makeEditor()

    const noEditor = render(
      <TagSuggestionPopover
        editor={{}}
        editorContainerRef={{ current: makeContainer() }}
        onSelect={vi.fn()}
      />
    )
    expect(noEditor.container).toBeEmptyDOMElement()

    render(
      <TagSuggestionPopover
        editor={editor}
        editorContainerRef={{ current: makeContainer() }}
        onSelect={vi.fn()}
      />
    )

    selection.from = 9
    act(() => {
      handlers.get('selectionUpdate')?.()
    })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()

    selection.from = 10
    selection.$from.parentOffset = 0
    act(() => {
      handlers.get('selectionUpdate')?.()
    })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()

    selection.$from.parentOffset = 2
    selection.$from.nodeBefore = {
      type: { name: 'paragraph' },
      attrs: {},
      nodeSize: 1
    }
    act(() => {
      handlers.get('selectionUpdate')?.()
    })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })
})

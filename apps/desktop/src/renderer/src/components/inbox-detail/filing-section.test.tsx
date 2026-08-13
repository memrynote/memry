import { act, renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithProviders, getMockApi, resetMockApi } from '@tests/utils/render'

import { AISettingsProvider } from '@/contexts/ai-settings-context'
import { FilingSection, useFilingState } from './filing-section'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values?.name ? `${key}:${values.name}` : key.split('.').at(-1) || key
  })
}))

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

vi.mock('@/components/filing/tag-autocomplete', () => ({
  TagAutocomplete: ({
    tags,
    onTagsChange,
    aiSuggestedTags
  }: {
    tags: string[]
    onTagsChange: (tags: string[]) => void
    aiSuggestedTags: string[]
  }) => (
    <div>
      <span>tags {tags.join(',')}</span>
      {aiSuggestedTags.length > 0 && <span>ai tags {aiSuggestedTags.join(',')}</span>}
      <button type="button" onClick={() => onTagsChange([...tags, 'review'])}>
        add tag
      </button>
    </div>
  )
}))

vi.mock('./link-input', () => ({
  LinkInput: ({
    linkedNotes,
    onLinkedNotesChange
  }: {
    linkedNotes: Array<{ id: string; title: string; type: string }>
    onLinkedNotesChange: (notes: Array<{ id: string; title: string; type: string }>) => void
  }) => (
    <div>
      <span>linked {linkedNotes.map((note) => note.title).join(',')}</span>
      <button
        type="button"
        onClick={() =>
          onLinkedNotesChange([...linkedNotes, { id: 'manual', title: 'Manual', type: 'note' }])
        }
      >
        link manual
      </button>
    </div>
  )
}))

vi.mock('@/lib/render-note-icon', () => ({
  NoteIconDisplay: ({ value }: { value: string }) => <span>{value}</span>
}))

const item = {
  id: 'inbox-1',
  type: 'link',
  title: 'Interesting link',
  tags: ['inbox']
} as any

describe('FilingSection', () => {
  beforeEach(() => {
    resetMockApi()
  })

  it('hides the folder picker while embedding, and brings it back for a sidebar file (#807)', async () => {
    const api = getMockApi() as any
    api.notes.getFolders.mockResolvedValue([{ path: 'Projects' }])
    api.inbox.getSuggestions.mockResolvedValue({ suggestions: [] })

    const onModeChange = vi.fn()
    const onRememberChange = vi.fn()
    const imageFiling = {
      mode: 'embed' as const,
      onModeChange,
      remember: false,
      onRememberChange,
      askUser: true
    }

    const { rerender } = renderWithProviders(
      <FilingSection
        item={{ ...item, type: 'image' }}
        selectedFolder={null}
        tags={[]}
        linkedNotes={[]}
        onFolderSelect={vi.fn()}
        onTagsChange={vi.fn()}
        onLinkedNotesChange={vi.fn()}
        imageFiling={imageFiling}
      />
    )

    // Embedding puts the file under the note's attachments — there is no folder
    // to choose, so promising one would be a lie. The chooser stays visible
    // regardless, or there would be no way back to the sidebar mode.
    expect(screen.getByTestId('image-filing-mode')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('searchOrCreateFolder')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('image-filing-mode-link'))
    expect(onModeChange).toHaveBeenCalledWith('link')

    await userEvent.click(screen.getByTestId('image-filing-mode-remember'))
    expect(onRememberChange).toHaveBeenCalledWith(true)

    rerender(
      <FilingSection
        item={{ ...item, type: 'image' }}
        selectedFolder={null}
        tags={[]}
        linkedNotes={[]}
        onFolderSelect={vi.fn()}
        onTagsChange={vi.fn()}
        onLinkedNotesChange={vi.fn()}
        imageFiling={{ ...imageFiling, mode: 'link' }}
      />
    )

    expect(await screen.findByPlaceholderText('searchOrCreateFolder')).toBeInTheDocument()
  })

  it('keeps the mode applied but stops asking once the user has answered (#807)', () => {
    const api = getMockApi() as any
    api.notes.getFolders.mockResolvedValue([{ path: 'Projects' }])
    api.inbox.getSuggestions.mockResolvedValue({ suggestions: [] })

    renderWithProviders(
      <FilingSection
        item={{ ...item, type: 'image' }}
        selectedFolder={null}
        tags={[]}
        linkedNotes={[]}
        onFolderSelect={vi.fn()}
        onTagsChange={vi.fn()}
        onLinkedNotesChange={vi.fn()}
        imageFiling={{
          mode: 'embed',
          onModeChange: vi.fn(),
          remember: true,
          onRememberChange: vi.fn(),
          askUser: false
        }}
      />
    )

    expect(screen.queryByTestId('image-filing-mode')).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText('searchOrCreateFolder')).not.toBeInTheDocument()
  })

  it('loads folders and AI suggestions, then drives folder, tag, and note-link changes', async () => {
    const api = getMockApi() as any
    api.notes.getFolders.mockResolvedValue([
      { path: 'Projects/memrynote', icon: 'M' },
      { path: 'Archive' }
    ])
    api.inbox.getSuggestions.mockResolvedValue({
      suggestions: [
        {
          destination: { type: 'folder', path: 'Projects/memrynote' },
          confidence: 0.91,
          reason: 'similar captures',
          suggestedTags: ['research']
        },
        {
          destination: { type: 'note' },
          confidence: 0.73,
          reason: 'related note',
          suggestedTags: ['link'],
          suggestedNote: { id: 'note-1', title: 'memrynote research', emoji: 'R' }
        }
      ]
    })

    const onFolderSelect = vi.fn()
    const onTagsChange = vi.fn()
    const onLinkedNotesChange = vi.fn()

    renderWithProviders(
      <FilingSection
        item={item}
        selectedFolder={null}
        tags={['inbox']}
        linkedNotes={[]}
        onFolderSelect={onFolderSelect}
        onTagsChange={onTagsChange}
        onLinkedNotesChange={onLinkedNotesChange}
      />
    )

    await waitFor(() =>
      expect(onFolderSelect).toHaveBeenCalledWith(
        expect.objectContaining({ path: 'Projects/memrynote', aiConfidence: 0.91 })
      )
    )

    expect(await screen.findAllByText('Projects / memrynote')).not.toHaveLength(0)
    expect(screen.getByText('ai tags research,link')).toBeInTheDocument()

    // Links collapse by default — expand to reveal AI note suggestions.
    await userEvent.click(screen.getByRole('button', { name: /linkANote/i }))
    expect(screen.getByText('memrynote research')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('searchOrCreateFolder')).toHaveClass(
      'h-5',
      'border-0',
      'leading-5',
      'focus-visible:ring-0'
    )

    await userEvent.click(screen.getByRole('button', { name: 'add tag' }))
    expect(onTagsChange).toHaveBeenCalledWith(['inbox', 'review'])

    await userEvent.click(screen.getByRole('button', { name: /memrynote research/ }))
    expect(onLinkedNotesChange).toHaveBeenCalledWith([
      { id: 'note-1', title: 'memrynote research', type: 'note' }
    ])

    await userEvent.clear(screen.getByPlaceholderText('searchOrCreateFolder'))
    await userEvent.type(screen.getByPlaceholderText('searchOrCreateFolder'), 'Areas/Writing')
    await userEvent.click(screen.getByRole('button', { name: 'detail.createFolder:Areas/Writing' }))

    await waitFor(() => expect(api.notes.createFolder).toHaveBeenCalledWith('Areas/Writing'))
    expect(onFolderSelect).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'Areas/Writing', path: 'Areas/Writing', parent: 'Areas' })
    )
  })

  it('does not fetch or display AI filing suggestions when AI is disabled', async () => {
    const api = getMockApi() as any
    api.settings.getAISettings.mockResolvedValue({ enabled: false })
    api.notes.getFolders.mockResolvedValue([
      { path: 'Projects/memrynote', icon: 'M' },
      { path: 'Archive' }
    ])
    api.inbox.getSuggestions.mockResolvedValue({
      suggestions: [
        {
          destination: { type: 'note' },
          confidence: 0.73,
          reason: 'related note',
          suggestedTags: ['link'],
          suggestedNote: { id: 'note-1', title: 'memrynote research', emoji: 'R' }
        }
      ]
    })

    renderWithProviders(
      <AISettingsProvider>
        <FilingSection
          item={item}
          selectedFolder={null}
          tags={['inbox']}
          linkedNotes={[]}
          onFolderSelect={vi.fn()}
          onTagsChange={vi.fn()}
          onLinkedNotesChange={vi.fn()}
        />
      </AISettingsProvider>
    )

    expect(await screen.findAllByText('Projects / memrynote')).not.toHaveLength(0)
    expect(api.inbox.getSuggestions).not.toHaveBeenCalled()
    expect(screen.queryByText(/ai tags/i)).not.toBeInTheDocument()
    expect(screen.queryByText('memrynote research')).not.toBeInTheDocument()
  })

  it('keeps filing state scoped to the active item session', () => {
    const { result, rerender } = renderHook(
      ({ currentItem, isOpen }: { currentItem: typeof item | null; isOpen: boolean }) =>
        useFilingState({ item: currentItem, isOpen }),
      { initialProps: { currentItem: item, isOpen: true } }
    )

    expect(result.current.tags).toEqual(['inbox'])
    expect(result.current.canFile).toBe(false)

    act(() => {
      result.current.setSelectedFolder({ id: 'Archive', name: 'Archive', path: 'Archive' } as any)
      result.current.setTags(['done'])
      result.current.setLinkedNotes([{ id: 'note-1', title: 'Note', type: 'note' } as any])
    })

    expect(result.current.canFile).toBe(true)
    expect(result.current.tags).toEqual(['done'])
    expect(result.current.linkedNotes).toHaveLength(1)

    rerender({ currentItem: { ...item, id: 'inbox-2', tags: ['fresh'] }, isOpen: true })

    expect(result.current.selectedFolder).toBeNull()
    expect(result.current.tags).toEqual(['fresh'])

    act(() => result.current.resetFilingState())
    expect(result.current.tags).toEqual([])
    expect(result.current.canFile).toBe(false)
  })
})

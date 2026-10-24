import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

import { TagPanel } from './tag-panel'
import type { Task } from '@/data/task-model'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

// The definitions store the display case ('MIT'), while tasks may carry a
// differently-cased tag ('mit') — this is what the case-insensitive lookups
// below exercise. Field is `tag`, not `name`.
vi.mock('@/hooks/use-notes-query', () => ({
  useNoteTagsQuery: () => ({
    tags: [
      { tag: 'MIT', color: 'rose', count: 0, icon: null },
      { tag: 'work', color: '', count: 0, icon: null }
    ]
  })
}))

const tasks: Task[] = [
  { tags: ['mit'] } as Task,
  { tags: ['mit', 'work'] } as Task,
  { tags: ['other'] } as Task
]

const renderPanel = (
  overrides: Partial<{
    searchQuery: string
    selectedTags: string[]
    onToggleTag: (tag: string) => void
    tasks: Task[]
  }> = {}
) => {
  const onToggleTag = overrides.onToggleTag ?? vi.fn()
  return {
    onToggleTag,
    ...render(
      <TagPanel
        searchQuery={overrides.searchQuery ?? ''}
        onSearchChange={vi.fn()}
        selectedTags={overrides.selectedTags ?? []}
        onToggleTag={onToggleTag}
        onClose={vi.fn()}
        onGoBack={vi.fn()}
        tasks={overrides.tasks ?? tasks}
      />
    )
  }
}

describe('TagPanel', () => {
  it('counts tags from tasks case-insensitively, keyed by the definition display name', () => {
    renderPanel()
    // 'MIT' definition should show count 2 (from lowercase 'mit' tasks),
    // proving the count lookup lowercases both sides.
    expect(screen.getByText('MIT')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.getByText('work')).toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()
  })

  it('toggles a tag using the definition display case, not the task-stored case', () => {
    const { onToggleTag } = renderPanel()
    fireEvent.click(screen.getByText('MIT'))
    expect(onToggleTag).toHaveBeenCalledWith('MIT')
  })

  it('shows a tag as selected when selectedTags has a different case', () => {
    renderPanel({ selectedTags: ['mit'] })
    // CheckMark renders inside the option button for the checked tag.
    const option = screen.getByText('MIT').closest('button')
    expect(option?.querySelector('[class*="shrink-0"] svg, svg')).toBeTruthy()
  })

  it('does not show a checkmark for an unselected tag', () => {
    renderPanel({ selectedTags: [] })
    const option = screen.getByText('work').closest('button')
    // No CheckMark svg should render for an unchecked option.
    const svgs = option?.querySelectorAll('svg') ?? []
    expect(svgs.length).toBe(0)
  })

  it('filters the tag list by search query', () => {
    renderPanel({ searchQuery: 'wo' })
    expect(screen.getByText('work')).toBeInTheDocument()
    expect(screen.queryByText('MIT')).not.toBeInTheDocument()
  })
})

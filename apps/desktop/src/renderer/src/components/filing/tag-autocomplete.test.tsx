import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TagAutocomplete } from './tag-autocomplete'

const tagMocks = vi.hoisted(() => ({
  searchTags: vi.fn(),
  getPopularTags: vi.fn(),
  getChildTags: vi.fn()
}))

const tagDefMocks = vi.hoisted(() => ({
  tags: [] as Array<{ name: string; color?: string; icon?: string | null }>
}))

vi.mock('@/hooks/use-all-tags', () => ({
  useAllTags: () => tagMocks
}))

vi.mock('@/hooks/use-tags', () => ({
  useTags: () => tagDefMocks
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key.split('.').pop() ?? key })
}))

describe('TagAutocomplete', () => {
  const onTagsChange = vi.fn()

  function ControlledAutocomplete({
    initialTags = ['existing', 'last']
  }: {
    initialTags?: string[]
  }): React.JSX.Element {
    const [tags, setTags] = useState(initialTags)
    return (
      <TagAutocomplete
        tags={tags}
        onTagsChange={(next) => {
          setTags(next)
          onTagsChange(next)
        }}
      />
    )
  }

  beforeEach(() => {
    vi.clearAllMocks()
    tagDefMocks.tags = []
    tagMocks.searchTags.mockReturnValue([
      { name: 'work', count: 9, source: 'notes' },
      { name: 'workflow', count: 3, source: 'inbox' }
    ])
    tagMocks.getPopularTags.mockReturnValue([
      { name: 'project', count: 12, source: 'notes' },
      { name: 'reading', count: 6, source: 'both' }
    ])
    tagMocks.getChildTags.mockReturnValue([
      { name: 'work/client', count: 2, source: 'notes' },
      { name: 'work/admin', count: 1, source: 'inbox' }
    ])
  })

  it('shows selected tags plus AI and popular suggestions, then adds the clicked suggestion', async () => {
    const user = userEvent.setup()
    render(
      <TagAutocomplete
        tags={['existing']}
        onTagsChange={onTagsChange}
        aiSuggestedTags={['focus', 'existing']}
      />
    )

    expect(screen.getByRole('listitem')).toHaveTextContent('existing')

    await user.click(screen.getByRole('combobox', { name: 'addTags' }))

    const listbox = await screen.findByRole('listbox', { name: 'tagSuggestions' })
    expect(within(listbox).getByText('focus')).toBeInTheDocument()
    expect(within(listbox).getByText('project')).toBeInTheDocument()

    await user.click(within(listbox).getByText('focus'))

    expect(onTagsChange).toHaveBeenCalledWith(['existing', 'focus'])
  })

  it('shows a suggestion with its saved color and icon', async () => {
    const user = userEvent.setup()
    tagMocks.getPopularTags.mockReturnValue([
      { name: 'project', count: 12, color: '#ff0000', source: 'notes' }
    ])
    tagDefMocks.tags = [{ name: 'project', icon: '🚀' }]

    render(<TagAutocomplete tags={[]} onTagsChange={onTagsChange} />)

    await user.click(screen.getByRole('combobox', { name: 'addTags' }))
    const listbox = await screen.findByRole('listbox', { name: 'tagSuggestions' })

    const pill = within(listbox).getByText('project')
    expect(pill).toHaveStyle({ color: '#ff0000' })
    expect(within(listbox).getByText('🚀')).toBeInTheDocument()
  })

  it('shows the saved color and icon on a selected tag pill', () => {
    tagDefMocks.tags = [{ name: 'existing', color: '#00ff00', icon: '📚' }]

    render(<TagAutocomplete tags={['existing']} onTagsChange={onTagsChange} />)

    const pill = screen.getByRole('listitem')
    expect(pill).toHaveTextContent('existing')
    expect(pill).toHaveStyle({ color: '#00ff00' })
    expect(within(pill).getByText('📚')).toBeInTheDocument()
  })

  it('creates tags from delimiters, keyboard selection, hierarchy search, and backspace removal', async () => {
    const user = userEvent.setup()
    render(<ControlledAutocomplete />)

    const input = screen.getByRole('combobox', { name: 'addTags' })
    await user.click(input)
    await user.type(input, 'urgent ')

    expect(onTagsChange).toHaveBeenCalledWith(['existing', 'last', 'urgent'])

    await user.clear(input)
    await user.type(input, 'wo')
    const matches = await screen.findByRole('listbox', { name: 'tagSuggestions' })
    expect(within(matches).getByText('workflow')).toBeInTheDocument()
    await user.keyboard('{ArrowDown}{Enter}')

    expect(onTagsChange).toHaveBeenCalledWith(['existing', 'last', 'urgent', 'workflow'])

    await user.clear(input)
    await user.type(input, 'work/')

    await waitFor(() => {
      expect(tagMocks.getChildTags).toHaveBeenCalledWith('work', undefined)
    })
    expect(screen.getByText('Sub-tags of work')).toBeInTheDocument()
    expect(screen.getByText('work/client')).toBeInTheDocument()

    await user.clear(input)
    await user.keyboard('{Backspace}')

    expect(onTagsChange).toHaveBeenCalledWith(['existing', 'last', 'urgent'])
  })

  it('closes the dropdown with Escape and outside clicks', async () => {
    const user = userEvent.setup()
    const { unmount } = render(
      <div>
        <TagAutocomplete tags={[]} onTagsChange={onTagsChange} />
        <button type="button">outside</button>
      </div>
    )

    const input = screen.getByRole('combobox', { name: 'addTags' })
    await user.click(input)
    expect(await screen.findByRole('listbox', { name: 'tagSuggestions' })).toBeInTheDocument()

    await user.keyboard('{Escape}')

    expect(screen.queryByRole('listbox', { name: 'tagSuggestions' })).not.toBeInTheDocument()

    unmount()

    render(
      <div>
        <TagAutocomplete tags={[]} onTagsChange={onTagsChange} />
        <button type="button">outside</button>
      </div>
    )

    await user.click(screen.getByRole('combobox', { name: 'addTags' }))
    expect(await screen.findByRole('listbox', { name: 'tagSuggestions' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'outside' }))

    await waitFor(() => {
      expect(screen.queryByRole('listbox', { name: 'tagSuggestions' })).not.toBeInTheDocument()
    })
  })

  describe('row variant', () => {
    it('removes a tag from its pill button, without the field-variant chrome', async () => {
      const user = userEvent.setup()
      render(
        <TagAutocomplete tags={['existing', 'last']} onTagsChange={onTagsChange} variant="row" />
      )

      // No section heading: the row is named by its tooltip.
      expect(screen.queryByText('tags')).not.toBeInTheDocument()
      expect(screen.getByTitle('tags')).toBeInTheDocument()

      // The i18n mock drops the {tag} param, so buttons are told apart by order.
      await user.click(screen.getAllByRole('button', { name: 'removeTag' })[0])
      expect(onTagsChange).toHaveBeenCalledWith(['last'])
    })

    it('ends a filled row on + , which opens the input in place', async () => {
      const user = userEvent.setup()
      render(<TagAutocomplete tags={['existing']} onTagsChange={onTagsChange} variant="row" />)

      await user.click(screen.getByRole('button', { name: 'addTags' }))

      expect(screen.getByRole('combobox', { name: 'addTags' })).toHaveFocus()
      expect(screen.queryByRole('button', { name: 'addTags' })).not.toBeInTheDocument()
      expect(await screen.findByRole('listbox', { name: 'tagSuggestions' })).toBeInTheDocument()
    })

    it('shows the input with an Add tags placeholder when empty', () => {
      render(<TagAutocomplete tags={[]} onTagsChange={onTagsChange} variant="row" />)

      expect(screen.getByPlaceholderText('addTags')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'addTags' })).not.toBeInTheDocument()
    })
  })
})

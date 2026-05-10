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

vi.mock('@/hooks/use-all-tags', () => ({
  useAllTags: () => tagMocks
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
})

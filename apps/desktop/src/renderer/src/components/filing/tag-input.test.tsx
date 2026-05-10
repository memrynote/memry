import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TagInput } from './tag-input'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

describe('TagInput', () => {
  const onTagsChange = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('adds comma, enter, and suggested tags while skipping duplicates', () => {
    const { rerender } = render(
      <TagInput tags={['work']} suggestedTags={['work', 'urgent']} onTagsChange={onTagsChange} />
    )

    const input = screen.getByLabelText('phaseF.componentsFilingTagInput.addTags2')
    fireEvent.change(input, { target: { value: 'Idea,' } })
    expect(onTagsChange).toHaveBeenCalledWith(['work', 'idea'])

    onTagsChange.mockClear()
    fireEvent.change(input, { target: { value: 'work,' } })
    expect(onTagsChange).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: 'later' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onTagsChange).toHaveBeenCalledWith(['work', 'later'])

    rerender(
      <TagInput tags={['work']} suggestedTags={['work', 'urgent']} onTagsChange={onTagsChange} />
    )
    fireEvent.click(screen.getByRole('button', { name: 'urgent' }))
    expect(onTagsChange).toHaveBeenCalledWith(['work', 'urgent'])
  })

  it('removes selected tags from button and empty backspace', () => {
    render(<TagInput tags={['work', 'home']} suggestedTags={[]} onTagsChange={onTagsChange} />)

    const selected = screen.getByRole('list', {
      name: 'phaseF.componentsFilingTagInput.selectedTags'
    })
    fireEvent.click(within(selected).getByRole('button', { name: 'Remove tag work' }))
    expect(onTagsChange).toHaveBeenCalledWith(['home'])

    fireEvent.keyDown(screen.getByLabelText('phaseF.componentsFilingTagInput.addTags2'), {
      key: 'Backspace'
    })
    expect(onTagsChange).toHaveBeenLastCalledWith(['work'])
  })
})

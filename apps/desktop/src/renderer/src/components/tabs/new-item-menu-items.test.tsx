import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Picker } from '@/components/ui/picker'
import { NewItemMenuItems, type NewItemActions } from './new-item-menu-items'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key.split('.').at(-1) ?? key })
}))

function renderMenu(actions: NewItemActions) {
  return render(
    <Picker open onOpenChange={() => {}}>
      <Picker.Content>
        <NewItemMenuItems actions={actions} />
      </Picker.Content>
    </Picker>
  )
}

describe('NewItemMenuItems', () => {
  it('fires the matching action for each item', () => {
    const actions: NewItemActions = {
      onNewNote: vi.fn(),
      onJournal: vi.fn(),
      onCalendar: vi.fn(),
      onInbox: vi.fn(),
      onTasks: vi.fn(),
      onTags: vi.fn()
    }
    renderMenu(actions)

    fireEvent.click(screen.getByText('newNote'))
    expect(actions.onNewNote).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByText('journal'))
    expect(actions.onJournal).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByText('calendar'))
    expect(actions.onCalendar).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByText('inboxCapture'))
    expect(actions.onInbox).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByText('tasks'))
    expect(actions.onTasks).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByText('tags'))
    expect(actions.onTags).toHaveBeenCalledTimes(1)
  })
})

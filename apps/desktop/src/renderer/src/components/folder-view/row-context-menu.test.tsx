import type React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { RowContextMenu } from './row-context-menu'
import type { NoteWithProperties } from '@memry/contracts/folder-view-api'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key.split('.').at(-1) ?? key })
}))

// Radix's ContextMenu never opens in jsdom (no real pointer/portal support),
// so - like virtualized-notes-tree.test.tsx - replace it with plain
// passthrough elements that always render their content.
vi.mock('@/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="context-menu">{children}</div>
  ),
  ContextMenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  ContextMenuSeparator: () => <hr />,
  ContextMenuShortcut: ({ children }: { children: React.ReactNode }) => <span>{children}</span>
}))

// The picker lives in a Dialog (Radix portal + modal focus trap is noisy in
// jsdom) and is code-split, so stub both: the dialog renders inline when open,
// the picker exposes one button per action.
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-testid="icon-dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>
}))

vi.mock('@/components/note/note-title/EmojiPicker', () => ({
  EmojiPicker: ({
    onSelect,
    onRemove,
    hasEmoji
  }: {
    onSelect: (icon: string) => void
    onRemove: () => void
    hasEmoji: boolean
  }) => (
    <div data-testid="emoji-picker" data-has-emoji={String(hasEmoji)}>
      <button type="button" onClick={() => onSelect('🚀')}>
        pick-rocket
      </button>
      <button type="button" onClick={onRemove}>
        picker-remove
      </button>
    </div>
  )
}))

const makeNote = (overrides: Partial<NoteWithProperties> = {}): NoteWithProperties =>
  ({
    id: 'note-1',
    title: 'Test note',
    emoji: null,
    folder: 'Home',
    tags: [],
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-01T00:00:00.000Z',
    wordCount: 10,
    properties: {},
    ...overrides
  }) as NoteWithProperties

const findButtonWithText = (text: string): HTMLElement => {
  const button = screen.getAllByRole('button').find((el) => el.textContent?.includes(text))
  if (!button) throw new Error(`no button found containing text: ${text}`)
  return button
}

const menuTexts = (): string[] => screen.getAllByRole('button').map((el) => el.textContent ?? '')

describe('RowContextMenu', () => {
  it('offers Delete and Move for a folder-scope row (kind absent) and they work', () => {
    const onDelete = vi.fn()
    const onMoveToFolder = vi.fn()

    render(
      <RowContextMenu
        note={makeNote()}
        isPartOfSelection={false}
        selectedCount={1}
        selectedNoteIds={['note-1']}
        onDelete={onDelete}
        onMoveToFolder={onMoveToFolder}
      >
        <div>row</div>
      </RowContextMenu>
    )

    fireEvent.click(screen.getByText('delete2'))
    expect(onDelete).toHaveBeenCalledWith(['note-1'])

    fireEvent.click(screen.getByText('Move to Folder...'))
    expect(onMoveToFolder).toHaveBeenCalledWith(['note-1'])
  })

  it('offers Delete and Move for an explicit note-kind row under tag scope', () => {
    const onDelete = vi.fn()
    const onMoveToFolder = vi.fn()

    render(
      <RowContextMenu
        note={makeNote({ id: 'note-2', kind: 'note' })}
        isPartOfSelection={false}
        selectedCount={1}
        selectedNoteIds={['note-2']}
        onDelete={onDelete}
        onMoveToFolder={onMoveToFolder}
      >
        <div>row</div>
      </RowContextMenu>
    )

    fireEvent.click(screen.getByText('delete2'))
    expect(onDelete).toHaveBeenCalledWith(['note-2'])

    fireEvent.click(screen.getByText('Move to Folder...'))
    expect(onMoveToFolder).toHaveBeenCalledWith(['note-2'])
  })

  it('does not offer Delete or Move for a task row under tag scope', () => {
    const onDelete = vi.fn()
    const onMoveToFolder = vi.fn()

    render(
      <RowContextMenu
        note={makeNote({ id: 'task-1', kind: 'task' })}
        isPartOfSelection={false}
        selectedCount={1}
        selectedNoteIds={['task-1']}
        onDelete={onDelete}
        onMoveToFolder={onMoveToFolder}
      >
        <div>row</div>
      </RowContextMenu>
    )

    expect(screen.queryByText('delete2')).not.toBeInTheDocument()
    expect(screen.queryByText('Move to Folder...')).not.toBeInTheDocument()
    expect(onDelete).not.toHaveBeenCalled()
    expect(onMoveToFolder).not.toHaveBeenCalled()
  })

  it('does not offer Delete or Move for an inbox row under tag scope', () => {
    const onDelete = vi.fn()
    const onMoveToFolder = vi.fn()

    render(
      <RowContextMenu
        note={makeNote({ id: 'inbox-1', kind: 'inbox' })}
        isPartOfSelection={false}
        selectedCount={1}
        selectedNoteIds={['inbox-1']}
        onDelete={onDelete}
        onMoveToFolder={onMoveToFolder}
      >
        <div>row</div>
      </RowContextMenu>
    )

    expect(screen.queryByText('delete2')).not.toBeInTheDocument()
    expect(screen.queryByText('Move to Folder...')).not.toBeInTheDocument()
    expect(onDelete).not.toHaveBeenCalled()
    expect(onMoveToFolder).not.toHaveBeenCalled()
  })

  it('labels bulk actions with the note-only count it actually acts on, not the raw selection size', () => {
    const onDelete = vi.fn()
    const onMoveToFolder = vi.fn()

    render(
      <RowContextMenu
        note={makeNote({ id: 'note-1' })}
        isPartOfSelection
        selectedCount={3}
        selectedNoteIds={['note-1']}
        onDelete={onDelete}
        onMoveToFolder={onMoveToFolder}
      >
        <div>row</div>
      </RowContextMenu>
    )

    const deleteButton = findButtonWithText('delete')
    expect(deleteButton.textContent).toContain('1')
    expect(deleteButton.textContent).not.toContain('3')
    fireEvent.click(deleteButton)
    expect(onDelete).toHaveBeenCalledWith(['note-1'])

    fireEvent.click(findButtonWithText('Move 1 Notes to Folder'))
    expect(onMoveToFolder).toHaveBeenCalledWith(['note-1'])
  })

  it('labels and acts on the note-only subset for a mixed multi-selection', () => {
    const onDelete = vi.fn()
    const onMoveToFolder = vi.fn()

    render(
      <RowContextMenu
        note={makeNote({ id: 'note-1' })}
        isPartOfSelection
        selectedCount={3}
        selectedNoteIds={['note-1', 'note-2']}
        onDelete={onDelete}
        onMoveToFolder={onMoveToFolder}
      >
        <div>row</div>
      </RowContextMenu>
    )

    const deleteButton = findButtonWithText('delete')
    expect(deleteButton.textContent).toContain('2')
    expect(deleteButton.textContent).not.toContain('3')
    fireEvent.click(deleteButton)
    expect(onDelete).toHaveBeenCalledWith(['note-1', 'note-2'])

    fireEvent.click(findButtonWithText('Move 2 Notes to Folder'))
    expect(onMoveToFolder).toHaveBeenCalledWith(['note-1', 'note-2'])
  })

  it('offers Set Icon and writes the picked icon back through onSetIcon', async () => {
    const onSetIcon = vi.fn()

    render(
      <RowContextMenu
        note={makeNote()}
        isPartOfSelection={false}
        selectedCount={1}
        selectedNoteIds={['note-1']}
        onSetIcon={onSetIcon}
      >
        <div>row</div>
      </RowContextMenu>
    )

    // No icon set yet, so Remove Icon must stay hidden.
    expect(screen.queryByText('removeIcon')).toBeNull()
    expect(screen.queryByTestId('icon-dialog')).toBeNull()

    fireEvent.click(screen.getByText('setIcon'))

    const picker = await screen.findByTestId('emoji-picker')
    expect(picker.dataset.hasEmoji).toBe('false')

    fireEvent.click(screen.getByText('pick-rocket'))
    expect(onSetIcon).toHaveBeenCalledWith('note-1', '🚀')
  })

  it('offers Remove Icon only when the row already has one, and clears it', () => {
    const onSetIcon = vi.fn()

    render(
      <RowContextMenu
        note={makeNote({ emoji: '📚' })}
        isPartOfSelection={false}
        selectedCount={1}
        selectedNoteIds={['note-1']}
        onSetIcon={onSetIcon}
      >
        <div>row</div>
      </RowContextMenu>
    )

    fireEvent.click(screen.getByText('removeIcon'))
    expect(onSetIcon).toHaveBeenCalledWith('note-1', null)
  })

  it('hides the icon actions for non-note rows and when no handler is wired', () => {
    const onSetIcon = vi.fn()

    const { unmount } = render(
      <RowContextMenu
        note={makeNote({ id: 'task-1', kind: 'task', emoji: '📚' })}
        isPartOfSelection={false}
        selectedCount={1}
        selectedNoteIds={[]}
        onSetIcon={onSetIcon}
      >
        <div>row</div>
      </RowContextMenu>
    )
    expect(screen.queryByText('setIcon')).toBeNull()
    expect(screen.queryByText('removeIcon')).toBeNull()
    unmount()

    render(
      <RowContextMenu
        note={makeNote({ emoji: '📚' })}
        isPartOfSelection={false}
        selectedCount={1}
        selectedNoteIds={['note-1']}
      >
        <div>row</div>
      </RowContextMenu>
    )
    expect(screen.queryByText('setIcon')).toBeNull()
    expect(screen.queryByText('removeIcon')).toBeNull()
  })

  it('does not offer bulk Delete or Move when the selection holds no notes', () => {
    const onDelete = vi.fn()
    const onMoveToFolder = vi.fn()

    render(
      <RowContextMenu
        note={makeNote({ id: 'task-1', kind: 'task' })}
        isPartOfSelection
        selectedCount={3}
        selectedNoteIds={[]}
        onDelete={onDelete}
        onMoveToFolder={onMoveToFolder}
      >
        <div>row</div>
      </RowContextMenu>
    )

    expect(menuTexts().some((text) => text.includes('Notes to Folder'))).toBe(false)
    expect(menuTexts().some((text) => text.includes('delete'))).toBe(false)
    expect(onDelete).not.toHaveBeenCalled()
    expect(onMoveToFolder).not.toHaveBeenCalled()
  })
})

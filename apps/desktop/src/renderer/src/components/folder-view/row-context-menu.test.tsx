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

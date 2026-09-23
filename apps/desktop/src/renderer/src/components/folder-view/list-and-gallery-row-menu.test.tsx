import type React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { NoteWithProperties } from '@memry/contracts/folder-view-api'
import { FolderListView } from './folder-list-view'
import { FolderGalleryView } from './folder-gallery-view'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key.split('.').at(-1) ?? key })
}))

vi.mock('@/hooks/use-tab-scroll-restore', () => ({
  useTabScrollRestore: () => undefined
}))

// Radix's ContextMenu never opens in jsdom, so render the menu content inline.
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

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-testid="icon-dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>
}))

vi.mock('@/components/note/note-title/EmojiPicker', () => ({
  EmojiPicker: ({ onSelect }: { onSelect: (icon: string) => void }) => (
    <button type="button" onClick={() => onSelect('🚀')}>
      pick-rocket
    </button>
  )
}))

const notes = [
  {
    id: 'note-1',
    path: 'Work/alpha.md',
    title: 'Alpha',
    emoji: '📚',
    folder: 'Work',
    tags: [],
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-01T00:00:00.000Z',
    wordCount: 10,
    properties: {}
  }
] as NoteWithProperties[]

const views = [
  ['FolderListView', FolderListView],
  ['FolderGalleryView', FolderGalleryView]
] as const

describe.each(views)('%s row context menu', (_name, View) => {
  it('sets and removes the row icon through rowActions.onSetIcon', async () => {
    const onSetIcon = vi.fn()
    render(
      <View notes={notes} tagMetaMap={new Map()} onNoteOpen={vi.fn()} rowActions={{ onSetIcon }} />
    )

    fireEvent.click(screen.getByText('setIcon'))
    fireEvent.click(await screen.findByText('pick-rocket'))
    fireEvent.click(screen.getByText('removeIcon'))

    expect(onSetIcon.mock.calls).toEqual([
      ['note-1', '🚀'],
      ['note-1', null]
    ])
  })

  it('renders no context menu without rowActions', () => {
    render(<View notes={notes} tagMetaMap={new Map()} onNoteOpen={vi.fn()} />)

    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.queryByTestId('context-menu')).toBeNull()
  })
})

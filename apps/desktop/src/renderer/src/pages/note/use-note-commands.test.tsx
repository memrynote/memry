import type { ReactNode } from 'react'
import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandId } from '@memry/contracts/commands'
import { publishActiveContext, runCommand, useAvailableCommands } from '@/commands'
import { resetCommandStoreForTests } from '@/commands/store'
import { TabIdentityProvider } from '@/contexts/tabs/tab-identity'
import type { DialogState } from '@/hooks/use-dialog-state'
import type { Note } from '@/hooks/use-notes-query'
import { useNoteCommands, type NoteDialog } from './use-note-commands'

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() })
}))
vi.mock('@/hooks/use-create-note-from-note', () => ({ useCreateNoteFromNote: () => vi.fn() }))
vi.mock('@/hooks/use-notes-query', () => ({
  useNoteMutations: () => ({ moveNote: { mutateAsync: vi.fn() } })
}))

const noteOf = (id: string, overrides: Partial<Note> = {}): Note =>
  ({ id, path: `${id}.md`, sizeClass: 'normal', frontmatter: {}, ...overrides }) as unknown as Note

interface PaneProps {
  note: Note
  dialog: DialogState<NoteDialog>
  isLocked?: boolean
  isDeleted?: boolean
  isBookmarked?: boolean
}

function NotePane({
  note,
  dialog,
  isLocked = false,
  isDeleted = false,
  isBookmarked = false
}: PaneProps): null {
  useNoteCommands({
    note,
    isDeleted,
    isLocked,
    hasOwnLock: false,
    isFullWidth: false,
    isLocalGraphOpen: false,
    setIsLocalGraphOpen: vi.fn(),
    dialog,
    titleInputRef: { current: null },
    openTemplateInsertRef: { current: null },
    openFind: vi.fn(),
    isBookmarked,
    toggleBookmark: vi.fn().mockResolvedValue(true),
    mindMap: { isAvailable: false, isOpen: false, toggle: vi.fn() },
    setLocalOnly: vi.fn().mockResolvedValue(undefined),
    setFullWidth: vi.fn().mockResolvedValue(undefined)
  })
  return null
}

const dialogSpy = (): DialogState<NoteDialog> => ({
  show: vi.fn(),
  close: vi.fn(),
  is: () => false,
  bind: () => ({ open: false, onOpenChange: vi.fn() })
})

const inTab = (tabId: string, node: ReactNode): ReactNode => (
  <TabIdentityProvider tabId={tabId} groupId="group">
    {node}
  </TabIdentityProvider>
)

const activate = (activeTabId: string): void => {
  act(() => publishActiveContext({ activeTabId, activeGroupId: 'group' }))
}

let available: ReadonlyArray<{ id: CommandId; label?: string }> = []
function Probe(): null {
  available = useAvailableCommands().commands
  return null
}

beforeEach(() => {
  resetCommandStoreForTests()
  available = []
})

describe('note commands', () => {
  it('acts on the note in the focused pane of a split view, and follows focus', async () => {
    const left = dialogSpy()
    const right = dialogSpy()
    render(
      <>
        {inTab('left', <NotePane note={noteOf('a')} dialog={left} />)}
        {inTab('right', <NotePane note={noteOf('b')} dialog={right} />)}
      </>
    )

    activate('right')
    await expect(runCommand('note.moveToFolder', 'palette')).resolves.toBe('ran')
    expect(right.show).toHaveBeenCalledWith('move')
    expect(left.show).not.toHaveBeenCalled()

    activate('left')
    await runCommand('note.moveToFolder', 'palette')
    expect(left.show).toHaveBeenCalledWith('move')
    expect(right.show).toHaveBeenCalledTimes(1)
  })

  it('opens the confirm dialog for delete and never deletes on its own', async () => {
    const dialog = dialogSpy()
    render(inTab('t', <NotePane note={noteOf('a')} dialog={dialog} />))
    activate('t')

    await runCommand('note.delete', 'palette')

    expect(dialog.show).toHaveBeenCalledWith('delete')
  })

  it('names the bookmark command for what it will do', () => {
    const { rerender } = render(
      <>
        <Probe />
        {inTab('t', <NotePane note={noteOf('a')} dialog={dialogSpy()} />)}
      </>
    )
    activate('t')
    expect(available.find((c) => c.id === 'note.toggleBookmark')?.label).toBe('Add bookmark')

    rerender(
      <>
        <Probe />
        {inTab('t', <NotePane note={noteOf('a')} dialog={dialogSpy()} isBookmarked />)}
      </>
    )
    expect(available.find((c) => c.id === 'note.toggleBookmark')?.label).toBe('Remove bookmark')
  })

  it('leaves a locked note read-only but movable, and offers nothing on a deleted one', () => {
    const { rerender } = render(
      <>
        <Probe />
        {inTab('t', <NotePane note={noteOf('a')} dialog={dialogSpy()} isLocked />)}
      </>
    )
    activate('t')
    const ids = (): CommandId[] => available.map((c) => c.id)
    expect(ids()).toContain('note.moveToFolder')
    expect(ids()).not.toContain('note.rename')
    expect(ids()).not.toContain('note.toggleLocalOnly')
    expect(ids()).not.toContain('note.toggleLock')

    rerender(
      <>
        <Probe />
        {inTab('t', <NotePane note={noteOf('a')} dialog={dialogSpy()} isDeleted />)}
      </>
    )
    // Find and Export stay: the native Edit and File menus reach them, and they did before.
    expect(
      ids()
        .filter((id) => id.startsWith('note.'))
        .sort()
    ).toEqual(['note.exportPdf', 'note.find'])
  })

  it('offers no template commands for a large file, which has no editor', () => {
    render(
      <>
        <Probe />
        {inTab(
          't',
          <NotePane note={noteOf('a', { sizeClass: 'large-file' })} dialog={dialogSpy()} />
        )}
      </>
    )
    activate('t')
    const ids = available.map((c) => c.id)
    expect(ids).not.toContain('note.applyTemplate')
    expect(ids).not.toContain('note.insertTemplate')
    expect(ids).toContain('note.saveAsTemplate')
  })
})

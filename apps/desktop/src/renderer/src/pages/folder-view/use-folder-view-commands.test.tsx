import type { ReactNode } from 'react'
import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ViewScope } from '@memry/contracts/folder-view-api'
import { publishActiveContext, runCommand } from '@/commands'
import { resetCommandStoreForTests } from '@/commands/store'
import { TabIdentityProvider } from '@/contexts/tabs/tab-identity'
import { useFolderViewCommands } from './use-folder-view-commands'

const mocks = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  openPage: vi.fn()
}))

vi.mock('@/hooks/use-notes-query', () => ({
  useNoteMutations: () => ({ createNote: { mutateAsync: mocks.mutateAsync } })
}))
vi.mock('@/hooks/use-open-target', () => ({ useOpenPage: () => ({ openPage: mocks.openPage }) }))
vi.mock('@/lib/new-note-title', () => ({
  NEW_NOTE_TITLE: 'Untitled',
  markNewNoteTitlePending: vi.fn()
}))

const spies = {
  openSearch: vi.fn(),
  openTagRename: vi.fn(),
  openTagDelete: vi.fn()
}

function FolderPane({ scope }: { scope: ViewScope }): null {
  useFolderViewCommands({ scope, ...spies })
  return null
}

const mount = (scope: ViewScope): ReactNode => (
  <TabIdentityProvider tabId="t" groupId="group">
    <FolderPane scope={scope} />
  </TabIdentityProvider>
)

const activate = (): void => {
  act(() => publishActiveContext({ activeTabId: 't', activeGroupId: 'group' }))
}

beforeEach(() => {
  resetCommandStoreForTests()
  vi.clearAllMocks()
  mocks.mutateAsync.mockResolvedValue({
    success: true,
    note: { id: 'n1', title: 'Untitled', emoji: null }
  })
})

describe('folder view commands', () => {
  it('creates the note inside the folder and opens it', async () => {
    render(mount({ kind: 'folder', path: 'Projects' }))
    activate()

    await runCommand('folder.newNote', 'palette')
    expect(mocks.mutateAsync).toHaveBeenCalledWith({ title: 'Untitled', folder: 'Projects' })
    expect(mocks.openPage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'note', entityId: 'n1' })
    )
  })

  it('creates the note with the scoped tag under a tag view', async () => {
    render(mount({ kind: 'tag', tag: 'work' }))
    activate()

    await runCommand('folder.newNote', 'palette')
    expect(mocks.mutateAsync).toHaveBeenCalledWith({ title: 'Untitled', tags: ['work'] })
  })

  it('offers the tag commands only under a tag, and delete only opens its confirm', async () => {
    const { rerender } = render(mount({ kind: 'folder', path: 'Projects' }))
    activate()
    await expect(runCommand('folder.renameTag', 'palette')).resolves.toBe('unavailable')
    await expect(runCommand('folder.deleteTag', 'palette')).resolves.toBe('unavailable')

    rerender(mount({ kind: 'tag', tag: 'work' }))
    await runCommand('folder.renameTag', 'palette')
    await runCommand('folder.deleteTag', 'palette')
    await runCommand('folder.search', 'palette')
    expect(spies.openTagRename).toHaveBeenCalledTimes(1)
    expect(spies.openTagDelete).toHaveBeenCalledTimes(1)
    expect(spies.openSearch).toHaveBeenCalledTimes(1)
  })
})

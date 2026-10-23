import type { ReactNode } from 'react'
import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { publishActiveContext, runCommand } from '@/commands'
import { resetCommandStoreForTests } from '@/commands/store'
import { TabIdentityProvider } from '@/contexts/tabs/tab-identity'
import { useFileCommands } from './use-file-commands'

const mocks = vi.hoisted(() => ({ openExternal: vi.fn(), revealInFinder: vi.fn() }))

vi.mock('@/hooks/use-note-file-actions', () => ({
  useNoteFileActions: () => ({
    openExternal: mocks.openExternal,
    revealInFinder: mocks.revealInFinder
  })
}))

function FilePane({
  fileId,
  openAddToProject
}: {
  fileId: string | null
  openAddToProject: () => void
}): null {
  useFileCommands({ fileId, openAddToProject })
  return null
}

const mount = (props: Parameters<typeof FilePane>[0]): ReactNode => (
  <TabIdentityProvider tabId="t" groupId="group">
    <FilePane {...props} />
  </TabIdentityProvider>
)

beforeEach(() => {
  resetCommandStoreForTests()
  vi.clearAllMocks()
})

describe('file commands', () => {
  it('runs the actions the info bar and the PDF menu run once the file has loaded', async () => {
    const openAddToProject = vi.fn()
    render(mount({ fileId: 'file-1', openAddToProject }))
    act(() => {
      publishActiveContext({ activeTabId: 't', activeGroupId: 'group' })
    })

    await runCommand('file.addToProject', 'palette')
    await runCommand('file.openExternal', 'palette')
    await runCommand('file.revealInFinder', 'palette')
    expect(openAddToProject).toHaveBeenCalledTimes(1)
    expect(mocks.openExternal).toHaveBeenCalledTimes(1)
    expect(mocks.revealInFinder).toHaveBeenCalledTimes(1)
  })

  it('offers nothing before the file metadata loads', async () => {
    render(mount({ fileId: null, openAddToProject: vi.fn() }))
    act(() => {
      publishActiveContext({ activeTabId: 't', activeGroupId: 'group' })
    })

    await expect(runCommand('file.openExternal', 'palette')).resolves.toBe('unavailable')
    expect(mocks.openExternal).not.toHaveBeenCalled()
  })
})

import type { ReactNode } from 'react'
import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandId } from '@memry/contracts/commands'
import { publishActiveContext, runCommand, useAvailableCommands } from '@/commands'
import { resetCommandStoreForTests } from '@/commands/store'
import { TabIdentityProvider } from '@/contexts/tabs/tab-identity'
import { useProjectCommands } from './use-project-commands'

interface PaneProps {
  hasProject?: boolean
  canArchive?: boolean
  openEditor?: () => void
  archive?: () => Promise<void>
  focusCapture?: () => void
}

function ProjectPane({
  hasProject = true,
  canArchive = true,
  openEditor = vi.fn(),
  archive = vi.fn().mockResolvedValue(undefined),
  focusCapture = vi.fn()
}: PaneProps): null {
  useProjectCommands({
    hasProject,
    canArchive,
    openEditor,
    archive,
    focusCapture,
    addNote: vi.fn().mockResolvedValue(undefined),
    openFilePicker: vi.fn(),
    addEvent: vi.fn()
  })
  return null
}

let available: ReadonlyArray<{ id: CommandId; label?: string }> = []
function Probe(): null {
  // oxlint-disable-next-line react/globals -- test probe component records latest hook output in a module variable for assertions
  available = useAvailableCommands().commands
  return null
}

const mount = (props: PaneProps): ReactNode => (
  <>
    <Probe />
    <TabIdentityProvider tabId="t" groupId="group">
      <ProjectPane {...props} />
    </TabIdentityProvider>
  </>
)

const activate = (): void => {
  act(() => publishActiveContext({ activeTabId: 't', activeGroupId: 'group' }))
}

beforeEach(() => {
  resetCommandStoreForTests()
  available = []
})

describe('project commands', () => {
  it('runs the same callbacks the header menu and the hub buttons run', async () => {
    const openEditor = vi.fn()
    const focusCapture = vi.fn()
    const archive = vi.fn().mockResolvedValue(undefined)
    render(mount({ openEditor, focusCapture, archive }))
    activate()

    await runCommand('project.edit', 'palette')
    await runCommand('project.addTask', 'palette')
    await runCommand('project.archive', 'palette')
    expect(openEditor).toHaveBeenCalledTimes(1)
    expect(focusCapture).toHaveBeenCalledTimes(1)
    expect(archive).toHaveBeenCalledTimes(1)
  })

  it('does not offer to archive the inbox project, as the header menu disables it', async () => {
    render(mount({ canArchive: false }))
    activate()

    await expect(runCommand('project.archive', 'palette')).resolves.toBe('unavailable')
    expect(available.map((c) => c.id)).toContain('project.edit')
  })

  it('offers nothing while the id resolves to no project', () => {
    render(mount({ hasProject: false }))
    activate()
    expect(available).toEqual([])
  })
})

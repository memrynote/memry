import type { ReactNode } from 'react'
import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { publishActiveContext, runCommand } from '@/commands'
import { resetCommandStoreForTests } from '@/commands/store'
import { TabIdentityProvider } from '@/contexts/tabs/tab-identity'
import { useTasksCommands } from './use-tasks-commands'

const mocks = vi.hoisted(() => ({ saveTabState: vi.fn() }))

vi.mock('@/contexts/tabs', () => ({
  useTabActions: () => ({ saveTabState: mocks.saveTabState }),
  useActiveTab: () => ({ id: 't' })
}))

function TasksPane({
  hasSelection,
  bulkComplete = vi.fn(),
  openBulkDelete = vi.fn()
}: {
  hasSelection: boolean
  bulkComplete?: () => void
  openBulkDelete?: () => void
}): null {
  useTasksCommands({ hasSelection, bulkComplete, openBulkDelete })
  return null
}

const mount = (props: Parameters<typeof TasksPane>[0]): ReactNode => (
  <TabIdentityProvider tabId="t" groupId="group">
    <TasksPane {...props} />
  </TabIdentityProvider>
)

beforeEach(() => {
  resetCommandStoreForTests()
  mocks.saveTabState.mockClear()
})

describe('tasks commands', () => {
  it('focuses the quick add by stamping the tab, with or without a selection', async () => {
    render(mount({ hasSelection: false }))
    act(() => publishActiveContext({ activeTabId: 't', activeGroupId: 'group' }))

    await expect(runCommand('tasks.newTask', 'palette')).resolves.toBe('ran')
    expect(mocks.saveTabState).toHaveBeenCalledWith('t', {
      viewState: { focusQuickAddAt: expect.any(Number) }
    })
  })

  it('offers the bulk commands only while tasks are selected', async () => {
    const bulkComplete = vi.fn()
    const openBulkDelete = vi.fn()
    const { rerender } = render(mount({ hasSelection: false, bulkComplete, openBulkDelete }))
    act(() => publishActiveContext({ activeTabId: 't', activeGroupId: 'group' }))

    await expect(runCommand('tasks.bulkComplete', 'palette')).resolves.toBe('unavailable')
    await expect(runCommand('tasks.bulkDelete', 'palette')).resolves.toBe('unavailable')

    rerender(mount({ hasSelection: true, bulkComplete, openBulkDelete }))
    await runCommand('tasks.bulkComplete', 'palette')
    await runCommand('tasks.bulkDelete', 'palette')
    expect(bulkComplete).toHaveBeenCalledTimes(1)
    // Delete only opens the page's confirm dialog.
    expect(openBulkDelete).toHaveBeenCalledTimes(1)
  })
})

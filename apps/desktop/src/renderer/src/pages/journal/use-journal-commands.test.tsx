import type { ReactNode } from 'react'
import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandId } from '@memry/contracts/commands'
import { publishActiveContext, runCommand, useAvailableCommands } from '@/commands'
import { resetCommandStoreForTests } from '@/commands/store'
import { TabIdentityProvider } from '@/contexts/tabs/tab-identity'
import type { DialogState } from '@/hooks/use-dialog-state'
import { useJournalCommands, type JournalDialog } from './use-journal-commands'

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() })
}))

interface PaneProps {
  viewType?: 'day' | 'month' | 'year'
  isToday?: boolean
  entryId?: string | null
  dialog?: DialogState<JournalDialog>
  goNext?: () => void
  goToday?: () => void
}

const dialogSpy = (): DialogState<JournalDialog> => ({
  show: vi.fn(),
  close: vi.fn(),
  is: () => false,
  bind: () => ({ open: false, onOpenChange: vi.fn() })
})

function JournalPane({
  viewType = 'day',
  isToday = false,
  entryId = 'j2026-01-13',
  dialog = dialogSpy(),
  goNext = vi.fn(),
  goToday = vi.fn()
}: PaneProps): null {
  useJournalCommands({
    viewType,
    isToday,
    entryId,
    isLocked: false,
    hasOwnLock: false,
    isFullWidth: false,
    isLocalGraphOpen: false,
    setIsLocalGraphOpen: vi.fn(),
    dialog,
    openTemplateInsertRef: { current: null },
    openFind: vi.fn(),
    goPrevious: vi.fn(),
    goNext,
    goToday,
    isBookmarked: false,
    toggleBookmark: vi.fn().mockResolvedValue(undefined),
    toggleFullWidth: vi.fn(),
    mindMap: { isAvailable: false, isOpen: false, toggle: vi.fn() }
  })
  return null
}

let available: ReadonlyArray<{ id: CommandId; label?: string }> = []
function Probe(): null {
  available = useAvailableCommands().commands
  return null
}

const mount = (props: PaneProps): ReactNode => (
  <>
    <Probe />
    <TabIdentityProvider tabId="t" groupId="group">
      <JournalPane {...props} />
    </TabIdentityProvider>
  </>
)

beforeEach(() => {
  resetCommandStoreForTests()
  available = []
})

describe('journal commands', () => {
  it('steps by the unit on screen', () => {
    const { rerender } = render(mount({ viewType: 'day' }))
    act(() => {
      publishActiveContext({ activeTabId: 't', activeGroupId: 'group' })
    })
    const label = (id: CommandId): string | undefined => available.find((c) => c.id === id)?.label
    expect(label('journal.next')).toBe('Next day')
    expect(label('journal.previous')).toBe('Previous day')

    rerender(mount({ viewType: 'month' }))
    expect(label('journal.next')).toBe('Next month')

    rerender(mount({ viewType: 'year' }))
    expect(label('journal.previous')).toBe('Previous year')
  })

  it('runs next and today, and offers Today only away from today', async () => {
    const goNext = vi.fn()
    const goToday = vi.fn()
    const { rerender } = render(mount({ goNext, goToday }))
    act(() => {
      publishActiveContext({ activeTabId: 't', activeGroupId: 'group' })
    })

    await runCommand('journal.next', 'palette')
    await runCommand('journal.today', 'palette')
    expect(goNext).toHaveBeenCalledTimes(1)
    expect(goToday).toHaveBeenCalledTimes(1)

    rerender(mount({ goNext, goToday, isToday: true }))
    await expect(runCommand('journal.today', 'palette')).resolves.toBe('unavailable')
  })

  it('only opens the confirm dialog for delete, and only for a day that has an entry', async () => {
    const dialog = dialogSpy()
    const { rerender } = render(mount({ dialog }))
    act(() => {
      publishActiveContext({ activeTabId: 't', activeGroupId: 'group' })
    })

    await runCommand('journal.delete', 'palette')
    expect(dialog.show).toHaveBeenCalledWith('delete')

    rerender(mount({ dialog, entryId: null }))
    await expect(runCommand('journal.delete', 'palette')).resolves.toBe('unavailable')
    expect(dialog.show).toHaveBeenCalledTimes(1)
  })

  it('leaves the day-only commands out of month and year views', () => {
    render(mount({ viewType: 'month' }))
    act(() => {
      publishActiveContext({ activeTabId: 't', activeGroupId: 'group' })
    })
    expect(available.map((c) => c.id).sort()).toEqual([
      'journal.next',
      'journal.previous',
      'journal.today'
    ])
  })
})

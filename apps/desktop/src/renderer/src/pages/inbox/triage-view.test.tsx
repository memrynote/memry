import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TriageView } from './triage-view'

const mocks = vi.hoisted(() => ({
  state: {
    isLoading: false,
    isComplete: false,
    completedCount: 1,
    totalItems: 2,
    currentIndex: 0,
    currentItem: {
      id: 'item-1',
      title: 'Reminder item',
      type: 'reminder',
      metadata: {
        targetType: 'note',
        targetId: 'note-1',
        targetTitle: 'Target note'
      }
    }
  } as Record<string, unknown>,
  actions: {
    advanceAfterExternalAction: vi.fn(),
    convertToTask: vi.fn(),
    expandToNote: vi.fn(),
    file: vi.fn(),
    defer: vi.fn()
  },
  archiveWithUndo: vi.fn(),
  openTab: vi.fn(),
  toastError: vi.fn(),
  logger: { error: vi.fn() },
  filingState: {
    selectedFolder: { id: 'folder-1', path: 'Projects' },
    tags: ['work'],
    linkedNotes: [] as Array<{ id: string }>,
    setSelectedFolder: vi.fn(),
    setTags: vi.fn(),
    setLinkedNotes: vi.fn(),
    canFile: true
  }
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${JSON.stringify(values)}` : key
  })
}))

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError }
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => mocks.logger
}))

vi.mock('@/hooks/use-triage-queue', () => ({
  useTriageQueue: () => ({ state: mocks.state, actions: mocks.actions })
}))

vi.mock('@/hooks/use-inbox', () => ({
  useInboxStats: () => ({ stats: { currentStreak: 3 } })
}))

vi.mock('@/hooks/use-undoable-action', () => ({
  useUndoableAction: () => ({ archiveWithUndo: mocks.archiveWithUndo })
}))

vi.mock('@/contexts/tabs', () => ({
  useTabs: () => ({ openTab: mocks.openTab })
}))

vi.mock('@/components/inbox/triage-progress', () => ({
  TriageProgress: ({ completed, total }: { completed: number; total: number }) => (
    <div data-testid="progress">
      {completed}/{total}
    </div>
  )
}))

vi.mock('@/components/inbox/triage-item-card', () => ({
  TriageItemCard: ({ item }: { item: { title: string } }) => <div>{item.title}</div>
}))

vi.mock('@/components/inbox/triage-action-bar', () => ({
  TriageActionBar: ({
    onPickerChange,
    onDiscard,
    onConvertToTask,
    onExpandToNote,
    onOpenTarget,
    disabled
  }: {
    onPickerChange: (picker: 'file' | 'snooze' | null) => void
    onDiscard: () => void
    onConvertToTask: () => void
    onExpandToNote: () => void
    onOpenTarget: () => void
    disabled: boolean
  }) => (
    <div>
      <button disabled={disabled} onClick={() => onPickerChange('file')}>
        file picker
      </button>
      <button disabled={disabled} onClick={() => onPickerChange('snooze')}>
        snooze picker
      </button>
      <button disabled={disabled} onClick={onDiscard}>
        discard
      </button>
      <button disabled={disabled} onClick={onConvertToTask}>
        task
      </button>
      <button disabled={disabled} onClick={onExpandToNote}>
        note
      </button>
      <button disabled={disabled} onClick={onOpenTarget}>
        open target
      </button>
    </div>
  )
}))

vi.mock('@/components/inbox/triage-complete', () => ({
  TriageComplete: ({
    processedCount,
    streak,
    onReturnToInbox
  }: {
    processedCount: number
    streak: number
    onReturnToInbox: () => void
  }) => (
    <button onClick={onReturnToInbox}>
      complete {processedCount} {streak}
    </button>
  )
}))

vi.mock('@/components/inbox/triage-snooze-picker', () => ({
  TriageSnoozePicker: ({ onSelect }: { onSelect: (date: string) => void }) => (
    <button onClick={() => onSelect('2026-05-12T00:00:00.000Z')}>pick snooze</button>
  )
}))

vi.mock('@/components/inbox/streak-badge', () => ({
  StreakBadge: ({ streak }: { streak: number }) => <span>streak {streak}</span>
}))

vi.mock('@/components/inbox-detail/filing-section', () => ({
  useFilingState: () => mocks.filingState,
  FilingSection: () => <div>filing section</div>
}))

describe('TriageView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    mocks.state.isLoading = false
    mocks.state.isComplete = false
    mocks.state.completedCount = 1
    mocks.state.totalItems = 2
    mocks.state.currentIndex = 0
    mocks.state.currentItem = {
      id: 'item-1',
      title: 'Reminder item',
      type: 'reminder',
      metadata: {
        targetType: 'note',
        targetId: 'note-1',
        targetTitle: 'Target note'
      }
    }
    mocks.archiveWithUndo.mockResolvedValue(undefined)
    mocks.actions.convertToTask.mockResolvedValue(undefined)
    mocks.actions.expandToNote.mockResolvedValue(undefined)
    mocks.actions.file.mockResolvedValue(undefined)
    mocks.actions.defer.mockResolvedValue(undefined)
    mocks.filingState.selectedFolder = { id: 'folder-1', path: 'Projects' }
    mocks.filingState.tags = ['work']
    mocks.filingState.linkedNotes = []
    mocks.filingState.canFile = true
  })

  it('renders the current item, opens the reminder target, and exits from the header', () => {
    const onExit = vi.fn()
    render(<TriageView onExit={onExit} />)

    expect(screen.getByText('Reminder item')).toBeInTheDocument()
    expect(screen.getByText('1/2')).toBeInTheDocument()
    expect(screen.getByText('streak 3')).toBeInTheDocument()

    fireEvent.click(screen.getByText('open target'))
    expect(mocks.openTab).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'note',
        entityId: 'note-1',
        isPreview: false
      })
    )

    fireEvent.click(screen.getByLabelText('triage.exitAria'))
    expect(onExit).toHaveBeenCalled()
  })

  it('runs file, snooze, discard, task, and expand actions after the slide delay', async () => {
    render(<TriageView onExit={vi.fn()} />)

    fireEvent.click(screen.getByText('file picker'))
    expect(screen.getByText('filing section')).toBeInTheDocument()
    fireEvent.click(screen.getByText('triage.action.file'))
    await act(async () => {
      vi.advanceTimersByTime(250)
    })
    expect(mocks.actions.file).toHaveBeenCalledWith({
      itemId: 'item-1',
      destination: { type: 'folder', path: 'Projects' },
      tags: ['work']
    })

    fireEvent.click(screen.getByText('snooze picker'))
    fireEvent.click(screen.getByText('pick snooze'))
    await act(async () => {
      vi.advanceTimersByTime(250)
    })
    expect(mocks.actions.defer).toHaveBeenCalledWith({
      itemId: 'item-1',
      snoozeUntil: '2026-05-12T00:00:00.000Z'
    })

    fireEvent.click(screen.getByText('discard'))
    await act(async () => {
      vi.advanceTimersByTime(250)
    })
    expect(mocks.archiveWithUndo).toHaveBeenCalledWith('item-1', 'Reminder item')
    expect(mocks.actions.advanceAfterExternalAction).toHaveBeenCalled()

    fireEvent.click(screen.getByText('task'))
    await act(async () => {
      vi.advanceTimersByTime(250)
    })
    expect(mocks.actions.convertToTask).toHaveBeenCalled()

    fireEvent.click(screen.getByText('note'))
    await act(async () => {
      vi.advanceTimersByTime(250)
    })
    expect(mocks.actions.expandToNote).toHaveBeenCalled()
  })

  it('shows loading, completion, empty, and failed-action states', async () => {
    const onExit = vi.fn()

    mocks.state.isLoading = true
    const view = render(<TriageView onExit={onExit} />)
    expect(document.querySelector('.animate-spin')).toBeInTheDocument()

    mocks.state.isLoading = false
    mocks.state.isComplete = true
    mocks.state.completedCount = 2
    view.rerender(<TriageView onExit={onExit} />)
    await waitFor(() => expect(screen.getByText('complete 2 3')).toBeInTheDocument())
    fireEvent.click(screen.getByText('complete 2 3'))
    expect(onExit).toHaveBeenCalled()

    view.unmount()
    mocks.state.isComplete = false
    mocks.state.completedCount = 0
    mocks.state.totalItems = 0
    mocks.state.currentItem = null
    const emptyView = render(<TriageView onExit={onExit} />)
    await waitFor(() => expect(onExit).toHaveBeenCalledTimes(2))

    emptyView.unmount()
    mocks.state.totalItems = 1
    mocks.state.currentItem = { id: 'item-2', title: 'Broken item', type: 'note' }
    mocks.actions.convertToTask.mockRejectedValueOnce(new Error('convert failed'))
    render(<TriageView onExit={onExit} />)
    fireEvent.click(screen.getByText('task'))
    await act(async () => {
      vi.advanceTimersByTime(250)
    })
    expect(mocks.toastError).toHaveBeenCalledWith('convert failed')
  })
})

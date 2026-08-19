import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import { InboxPage } from './inbox'

const mocks = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  items: [
    { id: 'item-1', type: 'link' },
    { id: 'item-2', type: 'note' }
  ],
  snoozedItems: [{ id: 'snoozed-1' }],
  upcomingCount: 1,
  activeJobCount: 1,
  failedJobCount: 1,
  activeTab: null as null | { viewState?: Record<string, unknown> }
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params?.count === undefined ? key : `${key}:${params.count}`
  })
}))

vi.mock('sonner', () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError
  }
}))

vi.mock('@/hooks/use-inbox-notifications', () => ({
  useInboxNotifications: vi.fn()
}))

vi.mock('@/hooks/use-inbox', () => ({
  useInboxList: () => ({ items: mocks.items }),
  useInboxSnoozed: () => ({ data: mocks.snoozedItems }),
  useInboxJobs: () => ({
    activeCount: mocks.activeJobCount,
    failedCount: mocks.failedJobCount
  })
}))

vi.mock('@/hooks/use-inbox-reminders-panel', () => ({
  useInboxRemindersPanel: () => ({
    upcoming: [],
    past: [],
    upcomingCount: mocks.upcomingCount,
    isLoading: false
  })
}))

vi.mock('@/contexts/tabs', () => ({
  useActiveTab: () => mocks.activeTab,
  // The page's own view state lives in the tab; outside a tab provider the hook
  // degrades to plain local state, which is what these tests exercise.
  useTabActionsOptional: () => null
}))

vi.mock('@/components/sr-announcer', () => ({
  SRAnnouncer: () => <div data-testid="sr-announcer" />
}))

vi.mock('@/components/ui/page-toolbar', () => ({
  PageToolbar: ({ children }: { children: ReactNode }) => <div role="toolbar">{children}</div>
}))

vi.mock('@/components/inbox/inbox-segment-control', () => ({
  InboxSegmentControl: ({
    value,
    onChange
  }: {
    value: string
    onChange: (value: 'inbox' | 'archived' | 'insights') => void
  }) => (
    <div data-testid="segment" data-view={value}>
      <button type="button" onClick={() => onChange('inbox')}>
        segment inbox
      </button>
      <button type="button" onClick={() => onChange('archived')}>
        segment archived
      </button>
      <button type="button" onClick={() => onChange('insights')}>
        segment insights
      </button>
    </div>
  )
}))

vi.mock('@/components/capture-input', () => ({
  CaptureInput: ({
    onCaptureSuccess,
    onCaptureError
  }: {
    onCaptureSuccess: () => void
    onCaptureError: (message: string) => void
  }) => (
    <div>
      <button type="button" onClick={onCaptureSuccess}>
        capture ok
      </button>
      <button type="button" onClick={() => onCaptureError('capture failed')}>
        capture fail
      </button>
    </div>
  )
}))

vi.mock('@/components/ui/picker', () => {
  const Picker = ({
    open,
    onOpenChange,
    onValueChange,
    children
  }: {
    open: boolean
    onOpenChange: (open: boolean) => void
    onValueChange: (value: string) => void
    children: ReactNode
  }) => (
    <div data-testid="picker" data-open={String(open)}>
      <button type="button" onClick={() => onOpenChange(!open)}>
        toggle filter
      </button>
      <button type="button" onClick={() => onValueChange('link')}>
        pick link
      </button>
      {children}
    </div>
  )
  Picker.Trigger = ({ children }: { children: ReactNode }) => <>{children}</>
  Picker.Content = ({ children }: { children: ReactNode }) => <div>{children}</div>
  Picker.List = ({ children }: { children: ReactNode }) => <div>{children}</div>
  Picker.Footer = ({ children }: { children: ReactNode }) => <div>{children}</div>
  Picker.Item = ({
    value,
    label,
    disabled,
    trailing
  }: {
    value: string
    label: string
    disabled?: boolean
    trailing?: ReactNode
  }) => (
    <div data-testid={`type-${value}`} data-disabled={String(!!disabled)}>
      {label}
      {trailing}
    </div>
  )
  return { Picker }
})

vi.mock('./inbox/inbox-list-view', () => ({
  InboxListView: ({
    selectedTypes,
    showSnoozedItems,
    focusItemId,
    focusToken
  }: {
    selectedTypes: Set<string>
    showSnoozedItems: boolean
    focusItemId: string | null
    focusToken: number | null
  }) => (
    <div
      data-testid="inbox-list"
      data-types={Array.from(selectedTypes).join(',')}
      data-snoozed={String(showSnoozedItems)}
      data-focus-id={focusItemId ?? ''}
      data-focus-token={focusToken ?? ''}
    />
  )
}))

vi.mock('./inbox/inbox-health-view', () => ({
  InboxHealthView: () => <div data-testid="health-view" />
}))

vi.mock('./inbox/inbox-archived-view', () => ({
  InboxArchivedView: ({ searchQuery }: { searchQuery: string }) => (
    <div data-testid="archived-view" data-query={searchQuery} />
  )
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() })
}))

describe('InboxPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.items = [
      { id: 'item-1', type: 'link' },
      { id: 'item-2', type: 'note' }
    ]
    mocks.snoozedItems = [{ id: 'snoozed-1' }]
    mocks.upcomingCount = 1
    mocks.activeJobCount = 1
    mocks.failedJobCount = 1
    mocks.activeTab = null
  })

  it('renders inbox toolbar actions, filters, snoozed state, and job summary', () => {
    render(<InboxPage className="custom-class" />)

    expect(screen.getByTestId('inbox-list')).toHaveAttribute('data-snoozed', 'false')
    expect(screen.getByText('view.jobs.running:1')).toBeInTheDocument()
    // Failed jobs are logged, not surfaced in the UI.
    expect(screen.queryByText('view.jobs.failed:1')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('capture ok'))
    fireEvent.click(screen.getByText('capture fail'))
    expect(mocks.toastSuccess).toHaveBeenCalledWith('view.itemCaptured')
    expect(mocks.toastError).toHaveBeenCalledWith('capture failed')

    fireEvent.click(screen.getByTitle('view.snoozed.showWithCount:1'))
    expect(screen.getByTestId('inbox-list')).toHaveAttribute('data-snoozed', 'true')

    fireEvent.click(screen.getByText('toggle filter'))
    expect(screen.getByTestId('picker')).toHaveAttribute('data-open', 'true')
    fireEvent.click(screen.getByText('pick link'))
    expect(screen.getByTestId('inbox-list')).toHaveAttribute('data-types', 'link')
    expect(screen.getByText('view.filter.clearAll')).toBeInTheDocument()
    fireEvent.click(screen.getByText('view.filter.clearAll'))
    expect(screen.getByTestId('inbox-list')).toHaveAttribute('data-types', '')
  })

  it('shows the upcoming reminder count on the snoozed view button', () => {
    mocks.upcomingCount = 3

    render(<InboxPage />)

    expect(screen.getByTitle('view.snoozed.showWithCount:3')).toBeInTheDocument()
  })

  it('switches views, searches archived items, and closes search when leaving archive', () => {
    render(<InboxPage />)

    fireEvent.click(screen.getByText('segment archived'))
    expect(screen.getByTestId('archived-view')).toHaveAttribute('data-query', '')

    fireEvent.click(screen.getByTitle('view.searchArchivedTitle'))
    const search = screen.getByPlaceholderText('view.searchPlaceholder')
    fireEvent.change(search, { target: { value: 'invoice' } })
    expect(screen.getByTestId('archived-view')).toHaveAttribute('data-query', 'invoice')

    fireEvent.keyDown(search, { key: 'Escape' })
    expect(screen.getByTestId('archived-view')).toHaveAttribute('data-query', '')

    fireEvent.click(screen.getByTitle('view.searchArchivedTitle'))
    fireEvent.change(search, { target: { value: 'clip' } })
    fireEvent.click(screen.getByText('segment insights'))
    expect(screen.getByTestId('health-view')).toBeInTheDocument()

    fireEvent.click(screen.getByText('segment archived'))
    expect(screen.getByTestId('archived-view')).toHaveAttribute('data-query', '')
  })

  it('consumes focused inbox item state once and reveals snoozed inbox rows', async () => {
    vi.useFakeTimers()
    mocks.activeTab = {
      viewState: {
        focusInboxItemId: 'snoozed-1',
        focusedAt: 10
      }
    }

    const { rerender } = render(<InboxPage />)
    act(() => {
      vi.runOnlyPendingTimers()
    })

    await waitFor(() => {
      expect(screen.getByTestId('inbox-list')).toHaveAttribute('data-snoozed', 'true')
    })
    expect(screen.getByTestId('inbox-list')).toHaveAttribute('data-focus-id', 'snoozed-1')

    fireEvent.click(screen.getByTitle('view.snoozed.hide'))
    expect(screen.getByTestId('inbox-list')).toHaveAttribute('data-snoozed', 'false')

    rerender(<InboxPage />)
    act(() => {
      vi.runOnlyPendingTimers()
    })
    expect(screen.getByTestId('inbox-list')).toHaveAttribute('data-snoozed', 'false')

    mocks.activeTab = {
      viewState: {
        focusInboxItemId: 'snoozed-1',
        focusedAt: 11
      }
    }
    rerender(<InboxPage />)
    act(() => {
      vi.runOnlyPendingTimers()
    })
    await waitFor(() => {
      expect(screen.getByTestId('inbox-list')).toHaveAttribute('data-snoozed', 'true')
    })

    vi.useRealTimers()
  })
})

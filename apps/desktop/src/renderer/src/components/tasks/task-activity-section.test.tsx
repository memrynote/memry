import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import type { ReactElement, ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRendererI18n } from '@memry/i18n/renderer'
import type { TaskActivityEntry } from '@memry/rpc/tasks'

const getActivity = vi.fn()

vi.mock('@/services/tasks-service', () => ({
  tasksService: { getActivity: (...args: unknown[]) => getActivity(...args) },
  onTaskUpdated: () => () => {},
  onTaskCompleted: () => () => {},
  onTaskMoved: () => () => {}
}))

import { TaskActivitySection } from './task-activity-section'

let i18nEn: I18nInstance

function makeEntry(overrides: Partial<TaskActivityEntry> = {}): TaskActivityEntry {
  return {
    id: 'a1',
    taskId: 'task-1',
    action: 'updated',
    field: 'dueDate',
    oldValue: JSON.stringify('2026-08-12'),
    newValue: JSON.stringify('2026-08-20'),
    actor: 'user',
    isThisDevice: true,
    createdAt: new Date().toISOString(),
    ...overrides
  }
}

function renderSection(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } }
  })
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18nEn}>{children}</I18nextProvider>
    </QueryClientProvider>
  )
  return render(ui, { wrapper: Wrapper })
}

beforeAll(async () => {
  i18nEn = await createRendererI18n({ locale: 'en' })
})

beforeEach(() => {
  getActivity.mockReset()
})

const section = (
  <TaskActivitySection
    taskId="task-1"
    taskTitle="Buy milk"
    language="en"
    label={<span>Activity</span>}
  />
)

describe('TaskActivitySection', () => {
  it('asks for exactly the preview page, not the whole feed', async () => {
    getActivity.mockResolvedValue({ entries: [], total: 0, hasMore: false })

    renderSection(section)

    await waitFor(() =>
      expect(getActivity).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: 'task-1', limit: 3, offset: 0 })
      )
    )
  })

  it('renders old → new for a field change', async () => {
    getActivity.mockResolvedValue({ entries: [makeEntry()], total: 1, hasMore: false })

    renderSection(section)

    expect(await screen.findByText('Due date')).toBeInTheDocument()
    expect(screen.getByText('2026-08-12')).toBeInTheDocument()
    expect(screen.getByText('2026-08-20')).toBeInTheDocument()
  })

  it('summarizes a description edit without ever rendering the body', async () => {
    getActivity.mockResolvedValue({
      entries: [
        makeEntry({
          field: 'description',
          oldValue: null,
          newValue: JSON.stringify({ delta: 42 })
        })
      ],
      total: 1,
      hasMore: false
    })

    renderSection(section)

    expect(await screen.findByText('+42 chars')).toBeInTheDocument()
  })

  it('labels a superseded row as replaced rather than naming a device', async () => {
    getActivity.mockResolvedValue({
      entries: [
        makeEntry({ action: 'superseded', isThisDevice: false, oldValue: JSON.stringify('P1') })
      ],
      total: 1,
      hasMore: false
    })

    renderSection(section)

    expect(await screen.findByText('Replaced by another device')).toBeInTheDocument()
  })

  it('offers "Show all" only when there is more than the preview', async () => {
    getActivity.mockResolvedValue({ entries: [makeEntry()], total: 12, hasMore: true })

    renderSection(section)

    expect(await screen.findByText('Show all 12')).toBeInTheDocument()
  })

  it('hides "Show all" when the preview already holds everything', async () => {
    getActivity.mockResolvedValue({ entries: [makeEntry()], total: 1, hasMore: false })

    renderSection(section)

    await screen.findByText('Due date')
    expect(screen.queryByText(/Show all/)).not.toBeInTheDocument()
  })

  it('invites the first edit when there is no history', async () => {
    getActivity.mockResolvedValue({ entries: [], total: 0, hasMore: false })

    renderSection(section)

    expect(
      await screen.findByText('Nothing recorded yet. Edits to this task appear here.')
    ).toBeInTheDocument()
  })
})

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import type { ReactElement, ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRendererI18n } from '@memry/i18n/renderer'
import type { TaskActivityEntry } from '@memry/rpc/tasks'

const getActivity = vi.fn()
let activityListener: ((event: { taskId: string }) => void) | null = null

vi.mock('@/services/tasks-service', () => ({
  tasksService: { getActivity: (...args: unknown[]) => getActivity(...args) },
  onTaskActivityCreated: (callback: (event: { taskId: string }) => void) => {
    activityListener = callback
    return () => {
      activityListener = null
    }
  }
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
    // Dates are shown the way the properties grid shows them, not as stored.
    expect(screen.getByText('Aug 12, 2026')).toBeInTheDocument()
    expect(screen.getByText('Aug 20, 2026')).toBeInTheDocument()
  })

  it('humanizes priority instead of showing the stored integer', async () => {
    getActivity.mockResolvedValue({
      entries: [makeEntry({ field: 'priority', oldValue: '0', newValue: '3' })],
      total: 1,
      hasMore: false
    })

    renderSection(section)

    expect(await screen.findByText('High')).toBeInTheDocument()
    expect(screen.queryByText('3')).not.toBeInTheDocument()
  })

  it('says a structured value changed rather than dumping its JSON', async () => {
    getActivity.mockResolvedValue({
      entries: [
        makeEntry({
          field: 'repeatConfig',
          oldValue: null,
          newValue: JSON.stringify({ frequency: 'weekly', interval: 1 })
        })
      ],
      total: 1,
      hasMore: false
    })

    renderSection(section)

    expect(await screen.findByText('changed')).toBeInTheDocument()
    expect(screen.queryByText(/frequency/)).not.toBeInTheDocument()
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

    // Keeps its timestamp: "when did I lose that edit" is the whole question.
    expect(await screen.findByText(/Replaced by another device ·/)).toBeInTheDocument()
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

  it('refreshes when a row is written for this task, and ignores other tasks', async () => {
    getActivity.mockResolvedValue({ entries: [], total: 0, hasMore: false })

    renderSection(section)
    await waitFor(() => expect(getActivity).toHaveBeenCalledTimes(1))

    // The Google Calendar writeback and a peer update that loses whole-row LWW
    // both write rows without emitting `tasks:updated`, so the feed listens to
    // the write itself.
    activityListener?.({ taskId: 'task-2' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(getActivity).toHaveBeenCalledTimes(1)

    activityListener?.({ taskId: 'task-1' })
    await waitFor(() => expect(getActivity).toHaveBeenCalledTimes(2))
  })

  it('invites the first edit when there is no history', async () => {
    getActivity.mockResolvedValue({ entries: [], total: 0, hasMore: false })

    renderSection(section)

    expect(
      await screen.findByText('Nothing recorded yet. Edits to this task appear here.')
    ).toBeInTheDocument()
  })
})

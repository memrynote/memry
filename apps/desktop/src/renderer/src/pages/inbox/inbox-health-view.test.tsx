import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { InboxHealthView } from './inbox-health-view'
import { useInboxFilingHistory, useInboxPatterns, useInboxStats } from '@/hooks/use-inbox'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    i18n: { language: 'en-US' },
    t: (key: string, params?: Record<string, unknown>) => {
      const label = key.split('.').at(-1) ?? key
      if (!params) return label
      return `${label} ${Object.values(params).join(' ')}`
    }
  })
}))

vi.mock('@/hooks/use-inbox', () => ({
  useInboxStats: vi.fn(),
  useInboxFilingHistory: vi.fn(),
  useInboxPatterns: vi.fn()
}))

const useInboxStatsMock = vi.mocked(useInboxStats)
const useInboxFilingHistoryMock = vi.mocked(useInboxFilingHistory)
const useInboxPatternsMock = vi.mocked(useInboxPatterns)

describe('InboxHealthView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.setSystemTime(new Date('2026-05-10T12:00:00Z'))
  })

  it('renders the loading state while stats load', () => {
    useInboxStatsMock.mockReturnValue({ stats: null, isLoading: true } as any)
    useInboxFilingHistoryMock.mockReturnValue({ data: undefined } as any)
    useInboxPatternsMock.mockReturnValue({ data: undefined } as any)

    const { container } = render(<InboxHealthView />)

    expect(container.querySelector('.animate-spin')).toBeInTheDocument()
  })

  it('renders stats, heatmap, type distribution, and recent filing rows', () => {
    const heatmap = Array.from({ length: 24 }, () => Array(7).fill(0))
    heatmap[10][2] = 5
    heatmap[11][2] = 2

    useInboxStatsMock.mockReturnValue({
      isLoading: false,
      stats: {
        totalItems: 18,
        capturedThisWeek: 10,
        processedThisWeek: 7,
        staleCount: 2,
        avgTimeToProcess: 150,
        itemsByType: {
          link: 6,
          note: 3,
          voice: 0,
          mystery: 1
        }
      }
    } as any)
    useInboxFilingHistoryMock.mockReturnValue({
      data: {
        entries: [
          {
            id: 'history-1',
            itemTitle: 'Research link',
            itemType: 'link',
            filedAction: 'filed',
            filedTo: 'Projects',
            filedAt: '2026-05-10T11:30:00Z'
          },
          {
            id: 'history-2',
            itemTitle: '',
            itemType: 'voice',
            filedAction: 'linked',
            filedTo: 'Tasks',
            filedAt: '2026-05-09T08:00:00Z'
          }
        ]
      }
    } as any)
    useInboxPatternsMock.mockReturnValue({ data: { timeHeatmap: heatmap } } as any)

    render(<InboxHealthView />)

    expect(screen.getByText('captured')).toBeInTheDocument()
    expect(screen.getAllByText('18')).not.toHaveLength(0)
    expect(screen.getByText('processRate 70')).toBeInTheDocument()
    expect(screen.getByText('needsAttention')).toBeInTheDocument()
    expect(screen.getByText('2.5h')).toBeInTheDocument()
    expect(screen.getByText(/peak/)).toBeInTheDocument()
    expect(screen.getByText('link')).toBeInTheDocument()
    expect(screen.getByText('Mystery')).toBeInTheDocument()
    expect(screen.getByText('Research link')).toBeInTheDocument()
    expect(screen.getByText('untitled')).toBeInTheDocument()
    expect(screen.getByText('convertedToTask')).toBeInTheDocument()
  })

  it('renders empty insights when there are no captures or filings', () => {
    useInboxStatsMock.mockReturnValue({
      isLoading: false,
      stats: {
        totalItems: 0,
        capturedThisWeek: 0,
        processedThisWeek: 0,
        staleCount: 0,
        avgTimeToProcess: 0,
        itemsByType: {}
      }
    } as any)
    useInboxFilingHistoryMock.mockReturnValue({ data: { entries: [] } } as any)
    useInboxPatternsMock.mockReturnValue({ data: { timeHeatmap: [] } } as any)

    render(<InboxHealthView />)

    expect(screen.getByText('allClear')).toBeInTheDocument()
    expect(screen.getByText('noCapturesYet')).toBeInTheDocument()
    expect(screen.getByText('noItemsYet')).toBeInTheDocument()
    expect(screen.getByText('noItemsFiled')).toBeInTheDocument()
  })
})

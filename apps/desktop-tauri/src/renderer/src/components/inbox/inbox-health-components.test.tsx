import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { InboxCaptureHeatmap } from './inbox-capture-heatmap'
import { InboxStatsCards } from './inbox-stats-cards'
import { InboxTypeDistribution } from './inbox-type-distribution'

// Stands in for the real bundle: the last key segment, prefixed with `count`
// when the caller passes one (the heatmap cell titles are an ICU plural).
vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, options?: { count?: number }) => {
      const label = key.split('.').at(-1) ?? key
      return options?.count === undefined ? label : `${options.count} ${label}`
    }
  })
}))

describe('inbox health components', () => {
  it('renders stats cards and loading skeletons', () => {
    const { container, rerender } = render(<InboxStatsCards stats={null} />)
    expect(container.querySelectorAll('.animate-pulse')).toHaveLength(4)

    rerender(
      <InboxStatsCards
        stats={
          {
            totalItems: 12,
            capturedToday: 3,
            processedToday: 4,
            avgTimeToProcess: 65_000,
            staleCount: 8
          } as any
        }
      />
    )

    expect(screen.getByText('Total Items')).toBeInTheDocument()
    expect(screen.getByText('12')).toBeInTheDocument()
    expect(screen.getByText('+3 today')).toBeInTheDocument()
    expect(screen.getByText('Processed Today')).toBeInTheDocument()
    expect(screen.getByText('4')).toBeInTheDocument()
    expect(screen.getByText('1m')).toBeInTheDocument()
    expect(screen.getByText('Needs attention')).toBeInTheDocument()
  })

  it('renders heatmap labels and intensity titles from two-hour buckets', () => {
    const heatmap = Array.from({ length: 24 }, () => Array(7).fill(0))
    heatmap[6][0] = 1
    heatmap[7][0] = 2
    heatmap[20][6] = 4
    heatmap[21][6] = 6

    render(<InboxCaptureHeatmap patterns={{ timeHeatmap: heatmap } as any} />)

    expect(screen.getByText('captureActivity')).toBeInTheDocument()
    expect(screen.getByText('Mon')).toBeInTheDocument()
    expect(screen.getByText('22')).toBeInTheDocument()
    expect(screen.getByTitle('3 captures')).toBeInTheDocument()
    expect(screen.getByTitle('10 captures')).toBeInTheDocument()
  })

  it('renders type distribution empty, sorted, known, unknown, and zero-count cases', () => {
    const { container, rerender } = render(<InboxTypeDistribution stats={null} />)
    expect(screen.getByText('noItemTypesToDisplay')).toBeInTheDocument()

    rerender(
      <InboxTypeDistribution
        stats={
          {
            itemsByType: {
              note: 2,
              mystery: 1,
              voice: 0,
              link: 5
            }
          } as any
        }
      />
    )

    expect(screen.getByText('itemTypes')).toBeInTheDocument()
    expect(screen.getByText('Link')).toBeInTheDocument()
    expect(screen.getByText('Note')).toBeInTheDocument()
    expect(screen.getByText('mystery')).toBeInTheDocument()
    expect(screen.queryByText('Voice')).not.toBeInTheDocument()
    expect(container.textContent?.indexOf('Link')).toBeLessThan(
      container.textContent?.indexOf('Note') ?? Number.MAX_SAFE_INTEGER
    )
    expect(container.querySelector('[style="width: 100%;"]')).toBeInTheDocument()
  })
})

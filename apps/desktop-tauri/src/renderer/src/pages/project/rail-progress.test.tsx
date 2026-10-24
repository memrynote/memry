import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { RailProgress } from './rail-progress'
import type { ProjectProgress } from './use-project-hub'

const base: ProjectProgress = {
  done: 12,
  total: 30,
  pct: 40,
  overdue: 3,
  statuses: [
    { id: 's1', name: 'To Do', color: '#6b7280', type: 'todo', count: 13 },
    { id: 's2', name: 'In Progress', color: '#f59e0b', type: 'in_progress', count: 5 },
    { id: 's3', name: 'Done', color: '#10b981', type: 'done', count: 12 }
  ]
}

describe('RailProgress', () => {
  it('renders one row per project status', () => {
    render(<RailProgress progress={base} />)

    expect(screen.getByText('To Do')).toBeInTheDocument()
    expect(screen.getByText('In Progress')).toBeInTheDocument()
    expect(screen.getByText('Done')).toBeInTheDocument()
    expect(screen.getByText('13')).toBeInTheDocument()
  })

  it('exposes the percentage on the progressbar', () => {
    render(<RailProgress progress={base} />)
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40')
  })

  it('renders a row for every custom status, including duplicate types', () => {
    render(
      <RailProgress
        progress={{
          ...base,
          statuses: [
            { id: 'a', name: 'Building', color: '#000', type: 'in_progress', count: 2 },
            { id: 'b', name: 'Reviewing', color: '#000', type: 'in_progress', count: 4 }
          ]
        }}
      />
    )
    expect(screen.getByText('Building')).toBeInTheDocument()
    expect(screen.getByText('Reviewing')).toBeInTheDocument()
  })

  it('hides the overdue row when nothing is overdue', () => {
    render(<RailProgress progress={{ ...base, overdue: 0 }} />)
    expect(screen.queryByText(/overdue/i)).not.toBeInTheDocument()
  })

  it('renders a zero-width bar for an empty project', () => {
    render(<RailProgress progress={{ done: 0, total: 0, pct: 0, overdue: 0, statuses: [] }} />)
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0')
  })
})

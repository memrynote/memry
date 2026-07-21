import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { ProjectStatsRow } from './project-stats-row'

describe('ProjectStatsRow', () => {
  it('#then renders counts and derived progress', () => {
    render(<ProjectStatsRow taskCount={4} noteCount={2} eventCount={1} progressPct={50} />)
    expect(screen.getByText('4')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()
    expect(screen.getByText('50%')).toBeInTheDocument()
  })
})

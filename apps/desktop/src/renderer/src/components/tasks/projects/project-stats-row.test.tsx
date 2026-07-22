import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { ProjectStatsRow } from './project-stats-row'

describe('ProjectStatsRow', () => {
  it('#then renders counts and derived progress', () => {
    render(
      <ProjectStatsRow taskCount={4} noteCount={2} eventCount={1} fileCount={3} progressPct={50} />
    )
    expect(screen.getByText('4')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()
    expect(screen.getByText('50%')).toBeInTheDocument()
  })

  it('#then renders the files tile', () => {
    render(
      <ProjectStatsRow taskCount={1} noteCount={2} eventCount={3} fileCount={4} progressPct={50} />
    )
    expect(screen.getByText('Files')).toBeInTheDocument()
    expect(screen.getByText('4')).toBeInTheDocument()
  })
})

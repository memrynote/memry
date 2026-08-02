import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { TabIcon } from './tab-icon'
import type { Project } from '@/data/tasks-data'

const projects: Project[] = []

vi.mock('@/contexts/tasks', () => ({
  useTasksOptional: () => ({ projects })
}))

vi.mock('@/components/icon-picker', () => ({
  getIconByName: (name: string) =>
    name === 'Folder'
      ? (props: { className?: string; style?: React.CSSProperties }) => (
          <span data-testid="lucide" className={props.className} style={props.style}>
            {name}
          </span>
        )
      : undefined
}))

vi.mock('@/lib/render-note-icon', () => ({
  NoteIconDisplay: ({ value, className }: { value: string; className?: string }) => (
    <span data-testid="note-icon" data-value={value} className={className}>
      {value}
    </span>
  )
}))

const makeProject = (overrides: Partial<Project> = {}): Project =>
  ({
    id: 'p1',
    name: 'Memry',
    description: '',
    icon: 'Folder',
    color: '#11aa55',
    statuses: [],
    isDefault: false,
    isArchived: false,
    createdAt: new Date(0),
    taskCount: 0,
    ...overrides
  }) as Project

const setProjects = (next: Project[]): void => {
  projects.length = 0
  projects.push(...next)
}

describe('TabIcon for project tabs', () => {
  it('renders the project emoji', () => {
    setProjects([makeProject({ icon: '📚' })])

    render(<TabIcon type="project" icon="folder" entityId="p1" />)

    expect(screen.getByTestId('note-icon')).toHaveAttribute('data-value', '📚')
  })

  it('renders the project icon value tinted with the project color', () => {
    setProjects([makeProject({ icon: 'icon:StarIcon', color: '#ff671a' })])

    render(<TabIcon type="project" icon="folder" entityId="p1" />)

    const icon = screen.getByTestId('note-icon')
    expect(icon).toHaveAttribute('data-value', 'icon:StarIcon')
    expect(icon.closest('[style]')).toHaveStyle({ color: '#ff671a' })
  })

  it('renders a color dot when the project has no custom icon', () => {
    setProjects([makeProject({ icon: '', color: '#11aa55' })])

    const { container } = render(<TabIcon type="project" icon="folder" entityId="p1" />)

    expect(container.querySelector('[data-testid="project-tab-color-dot"]')).toHaveStyle({
      backgroundColor: '#11aa55'
    })
  })

  it('falls back to the folder glyph when the project is unknown', () => {
    setProjects([])

    const { container } = render(<TabIcon type="project" icon="folder" entityId="missing" />)

    expect(container.querySelector('svg')).toBeInTheDocument()
  })
})

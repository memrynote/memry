import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ProjectEditor } from './ProjectEditor'

const listProjects = vi.fn()

vi.mock('@/services/tasks-service', () => ({
  tasksService: { listProjects: () => listProjects() },
  onProjectUpdated: () => () => {}
}))

const PROJECTS = [
  { id: 'p1', name: 'Alpha', color: '#ff0000', icon: '🚀', archivedAt: null },
  { id: 'p2', name: 'Beta', color: '#00ff00', icon: null, archivedAt: null },
  { id: 'p3', name: 'Old', color: '#0000ff', icon: null, archivedAt: '2026-01-01' }
]

describe('ProjectEditor', () => {
  beforeEach(() => {
    listProjects.mockResolvedValue({ projects: PROJECTS })
  })

  it('renders a chip per selected project with its emoji', async () => {
    render(<ProjectEditor value={['Alpha']} onChange={vi.fn()} />)

    expect(await screen.findByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('🚀')).toBeInTheDocument()
  })

  it('removes one project when its × is clicked', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<ProjectEditor value={['Alpha', 'Beta']} onChange={onChange} />)

    await user.click(await screen.findByRole('button', { name: /remove from alpha/i }))

    expect(onChange).toHaveBeenCalledWith(['Beta'])
  })

  it('leaves an empty array when the last project is removed', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<ProjectEditor value={['Alpha']} onChange={onChange} />)

    await user.click(await screen.findByRole('button', { name: /remove from alpha/i }))

    expect(onChange).toHaveBeenCalledWith([])
  })

  it('appends a picked project without dropping the existing ones', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<ProjectEditor value={['Alpha']} defaultOpen onChange={onChange} />)

    await user.click(await screen.findByRole('option', { name: /^beta$/i }))

    expect(onChange).toHaveBeenCalledWith(['Alpha', 'Beta'])
  })

  it('keeps a name that matches no project, rendered as unknown', async () => {
    render(<ProjectEditor value={['Ghost']} onChange={vi.fn()} />)

    expect(await screen.findByText(/ghost/i)).toBeInTheDocument()
  })

  it('renders an archived project already on the note but omits it from the picker', async () => {
    render(<ProjectEditor value={['Old']} defaultOpen onChange={vi.fn()} />)

    expect(await screen.findByText('Old')).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /^old$/i })).not.toBeInTheDocument()
  })
})

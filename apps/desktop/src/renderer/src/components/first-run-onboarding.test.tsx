import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FirstRunOnboarding } from './first-run-onboarding'

const mocks = vi.hoisted(() => ({
  createNote: vi.fn(),
  createTask: vi.fn(),
  createProject: vi.fn(),
  listProjects: vi.fn(),
  warn: vi.fn()
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ warn: mocks.warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() })
}))

vi.mock('@/services/notes-service', () => ({
  notesService: { create: mocks.createNote }
}))

vi.mock('@/services/tasks-service', () => ({
  tasksService: {
    create: mocks.createTask,
    createProject: mocks.createProject,
    listProjects: mocks.listProjects
  }
}))

describe('FirstRunOnboarding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.createNote.mockResolvedValue({ success: true })
    mocks.createTask.mockResolvedValue({ success: true })
    mocks.createProject.mockResolvedValue({
      success: true,
      project: { id: 'project-created', name: 'Personal' }
    })
    mocks.listProjects.mockResolvedValue({ projects: [{ id: 'project-existing' }] })
  })

  it('completes local onboarding after note and task setup without requiring sync signup', async () => {
    const onComplete = vi.fn()
    render(<FirstRunOnboarding onComplete={onComplete} />)

    fireEvent.click(screen.getByText('phaseF.componentsFirstRunOnboarding.getStarted'))
    fireEvent.change(
      screen.getByPlaceholderText(
        'phaseF.componentsFirstRunOnboarding.eGMeetingNotesIdeasAnything'
      ),
      { target: { value: 'Launch notes' } }
    )
    fireEvent.click(screen.getByText('phaseF.componentsFirstRunOnboarding.createNote'))

    await waitFor(() => {
      expect(mocks.createNote).toHaveBeenCalledWith({ title: 'Launch notes', content: '' })
    })

    fireEvent.change(
      screen.getByPlaceholderText('phaseF.componentsFirstRunOnboarding.eGReviewProjectProposal'),
      { target: { value: 'Review coverage' } }
    )
    fireEvent.click(screen.getByText('phaseF.componentsFirstRunOnboarding.createTask'))

    await waitFor(() => {
      expect(mocks.createTask).toHaveBeenCalledWith({
        projectId: 'project-existing',
        title: 'Review coverage'
      })
    })

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalled()
    })
    expect(
      screen.queryByText('phaseF.componentsFirstRunOnboarding.syncAcrossDevices')
    ).not.toBeInTheDocument()
  })

  it('creates a default project and completes even when setup calls fail', async () => {
    const onComplete = vi.fn()
    mocks.createNote.mockRejectedValueOnce(new Error('note failed'))
    mocks.listProjects.mockResolvedValueOnce({ projects: [] })

    render(<FirstRunOnboarding onComplete={onComplete} />)

    fireEvent.click(screen.getByText('phaseF.componentsFirstRunOnboarding.getStarted'))
    fireEvent.click(screen.getByText('phaseF.componentsFirstRunOnboarding.createNote'))

    await waitFor(() => {
      expect(mocks.warn).toHaveBeenCalledWith(
        'Failed to create onboarding note:',
        expect.any(Error)
      )
    })

    fireEvent.click(screen.getByText('phaseF.componentsFirstRunOnboarding.createTask'))

    await waitFor(() => {
      expect(mocks.createProject).toHaveBeenCalledWith({ name: 'Personal', color: '#6366f1' })
      expect(mocks.createTask).toHaveBeenCalledWith({
        projectId: 'project-created',
        title: 'My first task'
      })
    })

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalled()
    })
  })
})

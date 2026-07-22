import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AddFileToProjectDialog } from './add-file-to-project-dialog'

const mocks = vi.hoisted(() => ({
  listProjects: vi.fn(),
  linkProjectItem: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() })
}))
vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError }
}))
vi.mock('@/services/tasks-service', () => ({
  tasksService: { listProjects: mocks.listProjects, linkProjectItem: mocks.linkProjectItem }
}))

describe('AddFileToProjectDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listProjects.mockResolvedValue({
      projects: [{ id: 'p1', name: 'Launch', color: '#f00', archivedAt: null }]
    })
    mocks.linkProjectItem.mockResolvedValue({ success: true })
  })

  it('#then links the file to the chosen project as itemType file', async () => {
    render(<AddFileToProjectDialog open onOpenChange={vi.fn()} fileId="f1" />)

    await userEvent.click(await screen.findByText('Launch'))

    await waitFor(() =>
      expect(mocks.linkProjectItem).toHaveBeenCalledWith({
        projectId: 'p1',
        itemType: 'file',
        itemId: 'f1'
      })
    )
    expect(mocks.toastSuccess).toHaveBeenCalled()
  })
})

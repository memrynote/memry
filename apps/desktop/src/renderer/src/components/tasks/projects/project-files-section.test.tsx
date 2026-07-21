import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ProjectFilesSection } from './project-files-section'

const mocks = vi.hoisted(() => ({
  listProjectLinks: vi.fn(),
  unlinkProjectItem: vi.fn(),
  getFile: vi.fn()
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() })
}))
vi.mock('@/services/tasks-service', () => ({
  tasksService: {
    listProjectLinks: mocks.listProjectLinks,
    unlinkProjectItem: mocks.unlinkProjectItem
  }
}))
vi.mock('@/services/notes-service', () => ({
  notesService: { getFile: mocks.getFile }
}))

const fileLink = (id: string) => ({
  id: `link-${id}`,
  projectId: 'p1',
  itemType: 'file',
  itemId: id,
  position: 0,
  createdAt: ''
})

describe('ProjectFilesSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.unlinkProjectItem.mockResolvedValue({ success: true })
  })

  it('#then lists only file-typed links, resolved by getFile', async () => {
    mocks.listProjectLinks.mockResolvedValue([
      fileLink('f1'),
      { id: 'link-n', projectId: 'p1', itemType: 'note', itemId: 'n1', position: 0, createdAt: '' }
    ])
    mocks.getFile.mockImplementation(async (id: string) =>
      id === 'f1' ? { id: 'f1', title: 'Budget.pdf', fileType: 'pdf' } : null
    )

    render(<ProjectFilesSection projectId="p1" />)

    expect(await screen.findByText('Budget.pdf')).toBeInTheDocument()
    // The note-typed link is never resolved as a file.
    expect(mocks.getFile).toHaveBeenCalledTimes(1)
    expect(mocks.getFile).toHaveBeenCalledWith('f1')
  })

  it('#then skips orphaned file links whose getFile returns null', async () => {
    mocks.listProjectLinks.mockResolvedValue([fileLink('f1'), fileLink('gone')])
    mocks.getFile.mockImplementation(async (id: string) =>
      id === 'f1' ? { id: 'f1', title: 'Slide.png', fileType: 'image' } : null
    )

    render(<ProjectFilesSection projectId="p1" />)

    expect(await screen.findByText('Slide.png')).toBeInTheDocument()
    expect(screen.queryByText('gone')).not.toBeInTheDocument()
  })

  it('#then renders nothing when there are no file links', async () => {
    mocks.listProjectLinks.mockResolvedValue([])
    const { container } = render(<ProjectFilesSection projectId="p1" />)
    await waitFor(() => expect(mocks.listProjectLinks).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('#then unlinks a file on remove click', async () => {
    mocks.listProjectLinks.mockResolvedValue([fileLink('f1')])
    mocks.getFile.mockResolvedValue({ id: 'f1', title: 'Budget.pdf', fileType: 'pdf' })

    render(<ProjectFilesSection projectId="p1" />)
    await screen.findByText('Budget.pdf')

    await userEvent.click(screen.getByRole('button', { name: 'Remove from project' }))

    await waitFor(() =>
      expect(mocks.unlinkProjectItem).toHaveBeenCalledWith({
        projectId: 'p1',
        itemType: 'file',
        itemId: 'f1'
      })
    )
    expect(screen.queryByText('Budget.pdf')).not.toBeInTheDocument()
  })
})

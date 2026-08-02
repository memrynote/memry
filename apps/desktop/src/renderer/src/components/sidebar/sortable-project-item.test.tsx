import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import { SortableContext } from '@dnd-kit/sortable'
import { SortableProjectItem } from './sortable-project-item'
import { MEMRY_NOTE_DRAG_MIME } from '@/lib/drag-mime'
import { SidebarProvider } from '@/components/ui/sidebar'
import type { Project } from '@/data/tasks-data'

const mocks = vi.hoisted(() => ({
  getFile: vi.fn(),
  linkProjectItem: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }))
vi.mock('@/services/notes-service', () => ({ notesService: { getFile: mocks.getFile } }))
vi.mock('@/services/tasks-service', () => ({
  tasksService: { linkProjectItem: mocks.linkProjectItem }
}))

const project = { id: 'p1', name: 'Launch', color: '#f00', taskCount: 0 } as unknown as Project

const renderItem = () =>
  render(
    <SidebarProvider>
      <DndContext>
        <SortableContext items={['p1']}>
          <ul>
            <SortableProjectItem
              project={project}
              isActive={false}
              onClick={vi.fn()}
              onEdit={vi.fn()}
              onArchive={vi.fn()}
              onDelete={vi.fn()}
            />
          </ul>
        </SortableContext>
      </DndContext>
    </SidebarProvider>
  )

const noteDataTransfer = (id: string) => ({
  types: [MEMRY_NOTE_DRAG_MIME],
  getData: (type: string) => (type === MEMRY_NOTE_DRAG_MIME ? id : ''),
  dropEffect: 'none'
})

describe('SortableProjectItem label', () => {
  it('#then stretches the faded label so short names are not masked', () => {
    renderItem()

    const label = screen.getByText('Launch')
    expect(label.className).toContain('sidebar-label-fade')
    // Without flex-1 the span shrink-wraps the text and the fade mask lands on
    // the last characters of every name, however short.
    expect(label.className).toContain('flex-1')
  })

  it('#then uses the notes tree typography', () => {
    renderItem()

    const label = screen.getByText('Launch')
    expect(label.className).toContain('text-[13px]')
    expect(label.className).toContain('font-medium')
  })
})

describe('SortableProjectItem drop-to-link', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.linkProjectItem.mockResolvedValue({ success: true })
  })

  it('#then links a dropped markdown note as a note', async () => {
    mocks.getFile.mockResolvedValue(null)
    renderItem()

    fireEvent.drop(screen.getByText('Launch').closest('li')!, {
      dataTransfer: noteDataTransfer('n1')
    })

    await waitFor(() =>
      expect(mocks.linkProjectItem).toHaveBeenCalledWith({
        projectId: 'p1',
        itemType: 'note',
        itemId: 'n1'
      })
    )
    expect(mocks.toastSuccess).toHaveBeenCalled()
  })

  it('#then links a dropped file as a file', async () => {
    mocks.getFile.mockResolvedValue({ id: 'f1' })
    renderItem()

    fireEvent.drop(screen.getByText('Launch').closest('li')!, {
      dataTransfer: noteDataTransfer('f1')
    })

    await waitFor(() =>
      expect(mocks.linkProjectItem).toHaveBeenCalledWith({
        projectId: 'p1',
        itemType: 'file',
        itemId: 'f1'
      })
    )
  })
})

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SidebarCanvasList } from './sidebar-canvas-list'
import { SidebarProvider } from '@/components/ui/sidebar'
import type { CanvasSummary } from '@/services/canvas-service'

const mocks = vi.hoisted(() => ({
  list: vi.fn<() => Promise<{ canvases: CanvasSummary[] }>>(),
  createdCallbacks: [] as Array<() => void>,
  unsubscribeCreated: vi.fn(),
  unsubscribeUpdated: vi.fn(),
  unsubscribeDeleted: vi.fn()
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key.split('.').at(-1) ?? key })
}))

vi.mock('@/services/canvas-service', () => ({
  canvasService: { list: () => mocks.list() },
  onCanvasCreated: (callback: () => void) => {
    mocks.createdCallbacks.push(callback)
    return mocks.unsubscribeCreated
  },
  onCanvasUpdated: () => mocks.unsubscribeUpdated,
  onCanvasDeleted: () => mocks.unsubscribeDeleted
}))

vi.mock('@/hooks/use-sidebar-navigation', () => ({
  useSidebarNavigation: () => ({ isActiveItem: () => false })
}))

function summary(id: string, title: string | null): CanvasSummary {
  return { id, title, createdAt: 1, updatedAt: 1 }
}

function renderList(props: Partial<React.ComponentProps<typeof SidebarCanvasList>> = {}) {
  return render(
    <SidebarProvider>
      <SidebarCanvasList {...props} />
    </SidebarProvider>
  )
}

describe('SidebarCanvasList', () => {
  beforeEach(() => {
    mocks.list.mockReset()
    mocks.createdCallbacks.length = 0
    mocks.unsubscribeCreated.mockClear()
    mocks.unsubscribeUpdated.mockClear()
    mocks.unsubscribeDeleted.mockClear()
  })

  it('shows loading, then rows with untitled fallback; clicking a row reports the canvas', async () => {
    const onCanvasClick = vi.fn()
    mocks.list.mockResolvedValue({
      canvases: [summary('c1', 'Brainstorm'), summary('c2', null)]
    })

    renderList({ onCanvasClick })
    expect(screen.getByText('loading')).toBeInTheDocument()

    await waitFor(() => {
      expect(screen.getByText('Brainstorm')).toBeInTheDocument()
    })
    expect(screen.getByText('untitled')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Brainstorm'))
    expect(onCanvasClick).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }))
  })

  it('shows the empty state when no canvases exist', async () => {
    mocks.list.mockResolvedValue({ canvases: [] })

    renderList()
    await waitFor(() => {
      expect(screen.getByText('empty')).toBeInTheDocument()
    })
  })

  it('shows the error state when the list call fails', async () => {
    mocks.list.mockRejectedValue(new Error('ipc down'))

    renderList()
    await waitFor(() => {
      expect(screen.getByText('loadFailed')).toBeInTheDocument()
    })
  })

  it('refreshes on canvas events and unsubscribes on unmount', async () => {
    mocks.list.mockResolvedValueOnce({ canvases: [] })

    const { unmount } = renderList()
    await waitFor(() => {
      expect(screen.getByText('empty')).toBeInTheDocument()
    })

    mocks.list.mockResolvedValue({ canvases: [summary('c3', 'Fresh')] })
    mocks.createdCallbacks.forEach((callback) => callback())
    await waitFor(() => {
      expect(screen.getByText('Fresh')).toBeInTheDocument()
    })
    expect(mocks.list).toHaveBeenCalledTimes(2)

    unmount()
    expect(mocks.unsubscribeCreated).toHaveBeenCalled()
    expect(mocks.unsubscribeUpdated).toHaveBeenCalled()
    expect(mocks.unsubscribeDeleted).toHaveBeenCalled()
  })
})

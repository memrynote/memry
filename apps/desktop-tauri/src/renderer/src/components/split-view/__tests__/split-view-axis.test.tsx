import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ResizeHandle } from '../resize-handle'
import { SplitDropZones } from '../split-drop-zones'
import { SplitPreview } from '../split-preview'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string) => (key.endsWith('resizePanes') ? 'Resize panes' : key)
  })
}))

vi.mock('@dnd-kit/core', () => ({
  useDroppable: () => ({
    isOver: true,
    setNodeRef: vi.fn()
  })
}))

describe('split view axis UI', () => {
  it('renders top and bottom tab drop zones while dragging', () => {
    render(<SplitDropZones groupId="group-1" isActive />)

    expect(screen.getByText('Split Up')).toBeInTheDocument()
    expect(screen.getByText('Split Down')).toBeInTheDocument()
    expect(screen.getByText('Split Left')).toBeInTheDocument()
    expect(screen.getByText('Split Right')).toBeInTheDocument()
    expect(screen.getByText('Move Here')).toBeInTheDocument()
  })

  it('uses vertical preview geometry for top and bottom zones', () => {
    const { container, rerender } = render(<SplitPreview zone="top" />)
    const topPreview = container.firstElementChild as HTMLElement

    expect(topPreview.style.height).toBe('50%')
    expect(topPreview.style.width).toBe('')

    rerender(<SplitPreview zone="bottom" />)
    const bottomPreview = container.firstElementChild as HTMLElement

    expect(bottomPreview.style.height).toBe('50%')
    expect(bottomPreview.style.width).toBe('')
  })

  it('uses horizontal preview geometry for left and right zones', () => {
    const { container, rerender } = render(<SplitPreview zone="left" />)
    const leftPreview = container.firstElementChild as HTMLElement

    expect(leftPreview.style.width).toBe('50%')
    expect(leftPreview.style.height).toBe('')

    rerender(<SplitPreview zone="right" />)
    const rightPreview = container.firstElementChild as HTMLElement

    expect(rightPreview.style.width).toBe('50%')
    expect(rightPreview.style.height).toBe('')
  })

  it('maps split direction to separator orientation for resizing', () => {
    const { rerender } = render(
      <ResizeHandle direction="horizontal" isResizing={false} onResizeStart={vi.fn()} />
    )

    expect(screen.getByRole('separator', { name: 'Resize panes' })).toHaveAttribute(
      'aria-orientation',
      'vertical'
    )

    rerender(<ResizeHandle direction="vertical" isResizing={false} onResizeStart={vi.fn()} />)

    expect(screen.getByRole('separator', { name: 'Resize panes' })).toHaveAttribute(
      'aria-orientation',
      'horizontal'
    )
  })
})

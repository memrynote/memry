import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RecentlyOpenedWidget } from './recently-opened-widget'

vi.mock('@/hooks/use-recently-opened', () => ({
  useRecentlyOpened: () => ({
    items: [
      {
        itemId: 'n1',
        itemType: 'note',
        openedAt: new Date().toISOString(),
        title: 'Alpha',
        path: 'notes/alpha.md',
        emoji: null,
        fileType: 'markdown'
      },
      {
        itemId: 'n2',
        itemType: 'note',
        openedAt: new Date().toISOString(),
        title: 'Gamma',
        path: 'notes/Work/gamma.md',
        emoji: null,
        fileType: 'markdown'
      },
      {
        itemId: 'c1',
        itemType: 'canvas',
        openedAt: new Date().toISOString(),
        title: 'Sketchpad',
        path: 'canvases/Sketchpad.excalidraw',
        emoji: null,
        fileType: 'canvas'
      },
      {
        itemId: 'c2',
        itemType: 'canvas',
        openedAt: new Date().toISOString(),
        title: '',
        path: 'canvases',
        emoji: null,
        fileType: 'canvas'
      }
    ],
    isLoading: false,
    error: null
  })
}))

const openTab = vi.fn()

vi.mock('@/contexts/tabs/context', () => ({
  useTabActions: () => ({ openTab })
}))

describe('RecentlyOpenedWidget', () => {
  it('lists recently opened notes', () => {
    render(<RecentlyOpenedWidget config={{}} size="M" />)
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Gamma')).toBeInTheDocument()
  })

  // The two Home widgets sit side by side and can hold the same note; the verb
  // in the row subtitle is what tells "opened" apart from "edited".
  it('labels rows as opened, not edited', () => {
    render(<RecentlyOpenedWidget config={{}} size="M" />)
    expect(screen.getByText(/Work · opened/)).toBeInTheDocument()
    expect(screen.queryByText(/edited/)).not.toBeInTheDocument()
  })

  // Reported by a beta user: canvases she had opened never showed up here.
  it('lists recently opened canvases too', () => {
    render(<RecentlyOpenedWidget config={{}} size="M" />)
    expect(screen.getByText('Sketchpad')).toBeInTheDocument()
  })

  it('opens a canvas row in a canvas tab', async () => {
    const user = userEvent.setup()
    render(<RecentlyOpenedWidget config={{}} size="M" />)

    await user.click(screen.getByText('Sketchpad'))

    expect(openTab).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'canvas',
        title: 'Sketchpad',
        entityId: 'c1',
        path: '/canvas/c1'
      })
    )
  })

  // A canvas with no title is labelled the way the sidebar labels it, not left
  // as a blank row.
  it('labels an untitled canvas', () => {
    render(<RecentlyOpenedWidget config={{}} size="M" />)
    expect(screen.getByText('Untitled canvas')).toBeInTheDocument()
  })
})

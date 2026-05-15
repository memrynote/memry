import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AccessibleTabPanel } from './accessible-tab-panel'
import { SkipToContent } from './skip-to-content'
import { TabDragOverlay } from './tab-drag-overlay'
import {
  contentVariants,
  dragFeedbackVariants,
  dropZoneVariants,
  fadeVariants,
  slideInVariants,
  splitPaneVariants,
  tabVariants,
  tabVariantsReduced
} from './animations'

vi.mock('./tab-icon', () => ({
  TabIcon: ({ type }: { type: string }) => <span data-testid="tab-icon">{type}</span>
}))

describe('tabs small components', () => {
  const tab = {
    id: 'tab-1',
    type: 'note',
    title: 'Draft',
    icon: 'file',
    emoji: null,
    isPreview: false,
    isModified: true
  } as any

  it('renders accessible panel and skip link attributes', () => {
    render(
      <>
        <AccessibleTabPanel tab={tab}>Panel body</AccessibleTabPanel>
        <SkipToContent targetId="content">Jump</SkipToContent>
      </>
    )

    const panel = screen.getByRole('tabpanel')
    expect(panel).toHaveAttribute('id', 'tabpanel-tab-1')
    expect(panel).toHaveAttribute('aria-labelledby', 'tab-tab-1')
    expect(screen.getByRole('link', { name: 'Jump' })).toHaveAttribute('href', '#content')
  })

  it('renders drag overlay preview and animation constants', () => {
    render(<TabDragOverlay tab={tab} />)
    expect(screen.getByText('Draft')).toBeInTheDocument()
    expect(screen.getByTestId('tab-icon')).toHaveTextContent('note')

    expect(tabVariants.animate.width).toBe('auto')
    expect(tabVariantsReduced.exit.transition.duration).toBe(0.05)
    expect(contentVariants.initial.y).toBe(10)
    expect(splitPaneVariants.animate.opacity).toBe(1)
    expect(dragFeedbackVariants.dragging.zIndex).toBe(50)
    expect(dropZoneVariants.active.opacity).toBe(1)
    expect(fadeVariants.exit.opacity).toBe(0)
    expect(slideInVariants.left.initial.x).toBe(-20)
  })
})

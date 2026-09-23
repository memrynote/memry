import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

import { SidebarSection } from './sidebar-section'
import { SidebarProvider } from '@/components/ui/sidebar'

beforeEach(() => {
  localStorage.clear()
})

// jsdom does no layout, so this pins the contract the sidebar's scroll area
// and the virtualized tree rely on: a sticky, opaque, 24px (h-6) header row
// stacked above tree rows (z-20) and under the section drag grip (z-30).
describe('sidebar section header', () => {
  it('sticks to the top of the scroll area with an opaque background', () => {
    render(
      <SidebarProvider>
        <SidebarSection
          id="sticky"
          label="Collections"
          actions={<button type="button">Sort</button>}
        >
          <div>child</div>
        </SidebarSection>
      </SidebarProvider>
    )

    const header = screen.getByTestId('sidebar-section-header-sticky')
    expect(header).toHaveClass('sticky', 'top-0', 'z-20', 'h-6', 'bg-sidebar')
    // Label and actions both ride along.
    expect(header).toContainElement(screen.getByRole('button', { name: /Collections section/ }))
    expect(header).toContainElement(screen.getByRole('button', { name: 'Sort' }))
  })
})

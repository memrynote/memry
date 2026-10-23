import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

import { SidebarSection } from './sidebar-section'
import { SidebarProvider } from '@/components/ui/sidebar'
import {
  AA_SMALL_TEXT,
  THEMES,
  assertSmallTextContrast,
  contrastRatio,
  resolveColor
} from '@tests/utils/contrast'

// The section heading renders at 11px and its collapsed item count at 10px,
// which WCAG AA treats as small text and holds to 4.5:1. jsdom has no cascade
// and no layout, so the ratios are computed from the literal hex in base.css —
// see tests/utils/contrast.ts.

function renderSection(props: Partial<React.ComponentProps<typeof SidebarSection>> = {}) {
  return render(
    <SidebarProvider>
      <SidebarSection id="contrast" label="Notes" {...props}>
        <div>child</div>
      </SidebarSection>
    </SidebarProvider>
  )
}

function headerButton(): HTMLElement {
  renderSection()
  return screen.getByRole('button', { name: /^Notes section/ })
}

// `SidebarSection` seeds `isExpanded` from `sidebar-section-<id>-expanded` and
// writes it back on every toggle, and jsdom keeps localStorage for the whole
// file. A stored value silently outranks the `defaultExpanded={false}` the
// count test depends on, so clear it rather than let test order decide.
beforeEach(() => {
  localStorage.clear()
})

describe('sidebar section contrast', () => {
  it('defines the heading token in every sidebar theme', () => {
    for (const selector of THEMES) {
      expect(resolveColor(selector, '--sidebar-section-heading')).toMatch(/^#[0-9a-f]{6}$/i)
      expect(resolveColor(selector, '--sidebar')).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })

  it.each(THEMES)('clears WCAG AA for small text in %s', (selector) => {
    const heading = resolveColor(selector, '--sidebar-section-heading')
    const background = resolveColor(selector, '--sidebar')

    expect(contrastRatio(heading, background)).toBeGreaterThanOrEqual(AA_SMALL_TEXT)
  })

  it('paints the header with the heading token', () => {
    expect(headerButton().className.split(/\s+/)).toContain('text-sidebar-section-heading')
  })

  it('never swaps the header to a colour below AA on hover', () => {
    // The sidebar paints `bg-sidebar`; the header has no background of its own.
    expect(() => assertSmallTextContrast(headerButton().className, ['--sidebar'])).not.toThrow()
  })

  it('holds the collapsed item count to AA too', () => {
    // The count is the only thing left saying how much a collapsed section
    // hides, so it is informational text, not decoration.
    renderSection({ defaultExpanded: false, totalCount: 7 })
    const count = screen.getByText('(7)')

    expect(() => assertSmallTextContrast(count.className, ['--sidebar'])).not.toThrow()
    expect(count.className.split(/\s+/)).toContain('text-sidebar-section-heading')
  })
})

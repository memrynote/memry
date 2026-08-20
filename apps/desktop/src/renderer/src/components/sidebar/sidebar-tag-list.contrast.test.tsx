import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

import { SidebarTagList } from './sidebar-tag-list'
import { assertSmallTextContrast } from '@tests/utils/contrast'

// The tag list lives inside `bg-sidebar`. Its group headings render at 10px and
// its show-more control at 11px, both of which WCAG AA treats as small text and
// holds to 4.5:1. jsdom has no cascade and no layout, so the ratios come from
// the literal hex in base.css — see tests/utils/contrast.ts.

// The row-level middle-click / preference hooks reach useTabActions, which
// these renders have no TabProvider for — stub the whole open-target module.
vi.mock('@/hooks/use-open-target', () => ({
  useOpenTarget: () => ({ openInNewTab: vi.fn(), openToTheSide: vi.fn() }),
  useOpenPage: () => ({ openPage: vi.fn(), reuseActiveTab: false })
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      String(params?.count ?? key.split('.').at(-1) ?? key)
  })
}))

const TAGS = [
  { tag: 'alpha', count: 4, color: 'blue', icon: null, sortOrder: 0 },
  { tag: 'beta', count: 2, color: 'green', icon: null, sortOrder: 1 }
]

vi.mock('@/hooks/use-notes-query', () => ({
  useNoteTagsQuery: () => ({ tags: TAGS, isLoading: false, error: null })
}))

vi.mock('@/hooks/use-sidebar-navigation', () => ({
  useSidebarNavigation: () => ({ openSidebarItem: vi.fn() })
}))

vi.mock('@/hooks/use-tag-categories', () => ({
  useTagCategories: () => ({
    categories: [{ id: 'work', name: 'Work', sortOrder: 0, tags: TAGS }],
    uncategorized: [],
    isLoading: false,
    error: null
  })
}))

// `SidebarTagList` seeds its expanded set and its sort order from localStorage
// and writes the expanded set back on mount, and jsdom keeps localStorage for
// the whole file. A stored collapsed category hides every element these tests
// query, and a stored sort order changes which tag survives `maxVisible={1}`,
// so clear it rather than let test order decide.
beforeEach(() => {
  localStorage.clear()
})

// maxVisible below the group size is what makes the show-more control render.
function renderTagList(): void {
  render(<SidebarTagList maxVisible={1} />)
}

describe('sidebar tag list contrast', () => {
  it('holds the tag-group heading to AA at rest and on hover', () => {
    renderTagList()
    const heading = screen.getByRole('button', { name: 'collapse' })

    // The heading swaps its own background to `bg-muted` on hover, so it has to
    // clear the floor against both surfaces.
    expect(() => assertSmallTextContrast(heading.className, ['--sidebar', '--muted'])).not.toThrow()
    expect(heading.className.split(/\s+/)).toContain('text-sidebar-section-heading')
  })

  it('holds the show-more control to AA at rest and on hover', () => {
    renderTagList()
    // The mocked translator echoes the interpolated count, so "1" is the label
    // of "show 1 more".
    const showMore = screen.getByRole('button', { name: '1' })

    expect(() => assertSmallTextContrast(showMore.className, ['--sidebar'])).not.toThrow()
    expect(showMore.className.split(/\s+/)).toContain('text-sidebar-section-heading')
  })

  it('holds the per-tag note count to AA', () => {
    renderTagList()
    // The count only fades in while its row is hovered, and that same hover
    // paints the row `bg-muted`, so `--muted` is the only surface it sits on.
    const count = screen.getByText('4')

    expect(() => assertSmallTextContrast(count.className, ['--muted'])).not.toThrow()
    expect(count.className.split(/\s+/)).toContain('text-sidebar-section-heading')
  })
})

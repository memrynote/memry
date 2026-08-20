import { describe, expect, it } from 'vitest'

import { resolveSidebarSectionOrder, reorderSidebarSections } from './sidebar-section-order'

const DEFAULTS = ['collections', 'projects', 'bookmarks', 'canvases', 'tags']

describe('resolveSidebarSectionOrder', () => {
  it('falls back to the default order when nothing was ever saved', () => {
    expect(resolveSidebarSectionOrder(DEFAULTS, undefined)).toEqual(DEFAULTS)
    expect(resolveSidebarSectionOrder(DEFAULTS, [])).toEqual(DEFAULTS)
  })

  it('honours a full saved order', () => {
    const saved = ['tags', 'canvases', 'bookmarks', 'projects', 'collections']
    expect(resolveSidebarSectionOrder(DEFAULTS, saved)).toEqual(saved)
  })

  it('drops ids this build does not render', () => {
    // 'shelves' is a section from a newer build; 'canvases' can vanish when its
    // feature flag is off, and neither may leave a hole in the order.
    const saved = ['shelves', 'tags', 'collections', 'projects', 'bookmarks', 'canvases']
    const defaults = DEFAULTS.filter((id) => id !== 'canvases')

    expect(resolveSidebarSectionOrder(defaults, saved)).toEqual([
      'tags',
      'collections',
      'projects',
      'bookmarks'
    ])
  })

  it('drops duplicate ids instead of rendering a section twice', () => {
    expect(resolveSidebarSectionOrder(['a', 'b'], ['b', 'b', 'a', 'b'])).toEqual(['b', 'a'])
  })

  it('puts a section the saved order never saw back in its default slot', () => {
    // An order written before Canvases existed: it must reappear between
    // Bookmarks and Tags, not at the bottom and not nowhere.
    const saved = ['tags', 'collections', 'projects', 'bookmarks']

    expect(resolveSidebarSectionOrder(DEFAULTS, saved)).toEqual([
      'tags',
      'collections',
      'projects',
      'bookmarks',
      'canvases'
    ])
  })

  it('keeps a new first section at the top rather than appending it', () => {
    const saved = ['projects', 'collections']

    expect(resolveSidebarSectionOrder(['inbox', 'collections', 'projects'], saved)).toEqual([
      'inbox',
      'projects',
      'collections'
    ])
  })

  it('keeps several unseen sections in their default order relative to each other', () => {
    const saved = ['tags', 'collections']

    expect(resolveSidebarSectionOrder(DEFAULTS, saved)).toEqual([
      'tags',
      'collections',
      'projects',
      'bookmarks',
      'canvases'
    ])
  })
})

describe('reorderSidebarSections', () => {
  it('moves the dragged section to the target slot', () => {
    expect(reorderSidebarSections(DEFAULTS, 'tags', 'collections')).toEqual([
      'tags',
      'collections',
      'projects',
      'bookmarks',
      'canvases'
    ])
  })

  it('moves downwards too', () => {
    expect(reorderSidebarSections(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'c', 'a'])
  })

  it('reports no change when a section is dropped on itself', () => {
    expect(reorderSidebarSections(DEFAULTS, 'tags', 'tags')).toBeNull()
  })

  it('reports no change when the drop target is not a section', () => {
    // The sidebar shares one DndContext with tasks, projects and the folder
    // tree, so `over` is routinely something else entirely.
    expect(reorderSidebarSections(DEFAULTS, 'tags', 'project-42')).toBeNull()
  })
})

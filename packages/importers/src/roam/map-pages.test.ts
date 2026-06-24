import { describe, it, expect } from 'vitest'
import { mapPage, mapPages, splitTitlePath } from './map-pages.ts'
import { indexBlocks } from './index-blocks.ts'
import type { RoamPage } from './types.ts'

describe('splitTitlePath', () => {
  it('keeps single-segment titles flat under Roam', () => {
    expect(splitTitlePath('My Note')).toEqual({ folder: 'Roam', leafTitle: 'My Note' })
  })

  it('maps slash titles to nested folders with the leaf as title', () => {
    expect(splitTitlePath('A/B/C')).toEqual({ folder: 'Roam/A/B', leafTitle: 'C' })
  })

  it('trims and drops empty segments', () => {
    expect(splitTitlePath('A / B')).toEqual({ folder: 'Roam/A', leafTitle: 'B' })
  })
})

describe('mapPage', () => {
  it('builds a note plan with converted body and ms timestamps', () => {
    const page: RoamPage = {
      title: 'Notes',
      'create-time': 1709596800000,
      'edit-time': 1709683200000,
      children: [{ uid: 'x', string: 'hello' }]
    }
    const plan = mapPage(page, indexBlocks([page]))
    expect(plan.title).toBe('Notes')
    expect(plan.folder).toBe('Roam')
    expect(plan.body).toBe('- hello')
    expect(plan.isDailyNote).toBe(false)
    expect(plan.created).toBe(new Date(1709596800000).toISOString())
    expect(plan.modified).toBe(new Date(1709683200000).toISOString())
  })

  it('re-titles daily-note pages to the canonical journal date', () => {
    const page: RoamPage = {
      title: 'January 1st, 2024',
      children: [{ uid: 'd', string: 'journaled' }]
    }
    const plan = mapPage(page, indexBlocks([page]))
    expect(plan.isDailyNote).toBe(true)
    expect(plan.title).toBe('2024-01-01')
    expect(plan.folder).toBe('Roam')
  })

  it('resolves cross-page block refs in the body', () => {
    const pages: RoamPage[] = [
      { title: 'Source', children: [{ uid: 'src', string: 'the source text' }] },
      { title: 'Dest', children: [{ uid: 'd', string: 'see ((src))' }] }
    ]
    const index = indexBlocks(pages)
    const plan = mapPage(pages[1], index)
    expect(plan.body).toBe('- see [[Source]]: "the source text"')
  })
})

describe('mapPages', () => {
  it('maps every page into the plan', () => {
    const pages: RoamPage[] = [
      { title: 'One', children: [{ uid: '1', string: 'a' }] },
      { title: 'Two', children: [{ uid: '2', string: 'b' }] }
    ]
    const plan = mapPages(pages, indexBlocks(pages))
    expect(plan.notes).toHaveLength(2)
    expect(plan.notes.map((n) => n.title)).toEqual(['One', 'Two'])
  })
})

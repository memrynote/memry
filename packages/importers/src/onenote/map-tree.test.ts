import { describe, it, expect } from 'vitest'
import { mapTree } from './map-tree.ts'
import type { OneNotePage } from './types.ts'

const nb = { id: 'nb', displayName: 'Notebook A' }
const section = { id: 's', displayName: 'Section A', notebookId: 'nb' }

describe('mapTree', () => {
  it('maps notebooks/sections/pages into OneNote folders', () => {
    const plans = mapTree([nb], [section], [{ id: 'p', title: 'Page A', sectionId: 's' }])
    expect(plans).toEqual([
      { pageId: 'p', title: 'Page A', folder: 'OneNote/Notebook A/Section A' }
    ])
  })

  it('places section-group sections under their group path', () => {
    const plans = mapTree(
      [nb],
      [{ id: 's', displayName: 'Inner', notebookId: 'nb', groupPath: ['Group 1', 'Group 2'] }],
      [{ id: 'p', title: 'Deep', sectionId: 's' }]
    )
    expect(plans[0].folder).toBe('OneNote/Notebook A/Group 1/Group 2/Inner')
  })

  it('sanitizes reserved filename characters in every segment', () => {
    const plans = mapTree(
      [{ id: 'nb', displayName: 'Work: 2026/Q3' }],
      [{ id: 's', displayName: 'A|B?', notebookId: 'nb' }],
      [{ id: 'p', title: 'Page', sectionId: 's' }]
    )
    expect(plans[0].folder).toBe('OneNote/Work 2026Q3/AB')
  })

  it('drops pages whose section or notebook is missing', () => {
    const plans = mapTree(
      [nb],
      [section, { id: 'orphan-section', displayName: 'X', notebookId: 'missing-nb' }],
      [
        { id: 'p1', title: 'Kept', sectionId: 's' },
        { id: 'p2', title: 'No section', sectionId: 'missing' },
        { id: 'p3', title: 'No notebook', sectionId: 'orphan-section' }
      ]
    )
    expect(plans.map((p) => p.title)).toEqual(['Kept'])
  })

  it('carries created + modified timestamps and defaults empty titles', () => {
    const plans = mapTree(
      [nb],
      [section],
      [
        {
          id: 'p',
          title: '   ',
          sectionId: 's',
          createdDateTime: '2024-03-05T10:00:00Z',
          lastModifiedDateTime: '2024-04-06T11:00:00Z'
        }
      ]
    )
    expect(plans[0]).toMatchObject({
      title: 'Untitled',
      created: '2024-03-05T10:00:00Z',
      modified: '2024-04-06T11:00:00Z'
    })
  })

  it('nests subpages under their parent page folder (parent file moves in too)', () => {
    const pages: OneNotePage[] = [
      { id: 'a', title: 'Alpha', sectionId: 's', level: 0 },
      { id: 'a1', title: 'Alpha Child', sectionId: 's', level: 1 },
      { id: 'a1x', title: 'Alpha Grandchild', sectionId: 's', level: 2 },
      { id: 'a2', title: 'Alpha Child 2', sectionId: 's', level: 1 },
      { id: 'b', title: 'Beta', sectionId: 's', level: 0 }
    ]
    const plans = mapTree([nb], [section], pages)
    const byId = Object.fromEntries(plans.map((p) => [p.pageId, p.folder]))
    const base = 'OneNote/Notebook A/Section A'
    expect(byId.a).toBe(`${base}/Alpha`)
    expect(byId.a1).toBe(`${base}/Alpha/Alpha Child`)
    expect(byId.a1x).toBe(`${base}/Alpha/Alpha Child`)
    expect(byId.a2).toBe(`${base}/Alpha`)
    expect(byId.b).toBe(base)
  })

  it('treats a subpage with no preceding parent as top level', () => {
    const plans = mapTree([nb], [section], [{ id: 'p', title: 'Lone', sectionId: 's', level: 2 }])
    expect(plans[0].folder).toBe('OneNote/Notebook A/Section A')
  })
})

describe('mapTree path safety', () => {
  it('never lets a source name traverse out of the import root', () => {
    const plans = mapTree(
      [{ id: 'nb', displayName: '..' }],
      [{ id: 's', displayName: '..', notebookId: 'nb', groupPath: ['..'] }],
      [{ id: 'p', title: 'Payload', sectionId: 's' }]
    )
    expect(plans[0].folder).toBe('OneNote/Untitled/Untitled/Untitled')
    expect(plans[0].folder).not.toContain('..')
  })

  it('strips leading dots from hidden-style names', () => {
    const plans = mapTree(
      [{ id: 'nb', displayName: '.hidden' }],
      [{ id: 's', displayName: 'Sec', notebookId: 'nb' }],
      [{ id: 'p', title: 'P', sectionId: 's' }]
    )
    expect(plans[0].folder).toBe('OneNote/hidden/Sec')
  })
})

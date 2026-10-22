import { describe, expect, it, vi } from 'vitest'
import { collectAnchors, findBlockHosts, guardBlockText, mergeHosts } from './portal-delete-guard'

const run = (text: string) => [{ type: 'text', text, styles: {} }]
const host = (noteId: string, count = 1, hiddenCount = 0) => ({
  noteId,
  title: noteId,
  path: `${noteId}.md`,
  count,
  hiddenCount
})

describe('collectAnchors', () => {
  it('finds anchors on the block and its descendants, not mid-text carets', () => {
    const blocks = [
      {
        id: 'a',
        content: run('Chloroplast ^chl-7f2a'),
        children: [
          { id: 'b', content: run('plain 2^10') },
          { id: 'c', content: run('Deep ^deep1') }
        ]
      }
    ]
    expect(collectAnchors(blocks)).toEqual(['chl-7f2a', 'deep1'])
  })

  it('reads text through links', () => {
    expect(
      guardBlockText({
        id: 'a',
        content: [{ type: 'link', href: 'x', content: run('see ') }, ...run('^abcd')]
      })
    ).toBe('see ^abcd')
  })
})

describe('mergeHosts', () => {
  it('adds counts per host note and skips the source', () => {
    expect(mergeHosts('src', [[host('lab', 1, 1), host('src')], [host('lab', 2, 0)]])).toEqual([
      host('lab', 3, 1)
    ])
  })
})

describe('findBlockHosts', () => {
  it('does not ask usage for a block with no anchor', async () => {
    const getUsage = vi.fn()
    expect(await findBlockHosts('src', [{ id: 'a', content: run('plain') }], getUsage)).toEqual([])
    expect(getUsage).not.toHaveBeenCalled()
  })

  it('asks once per anchor', async () => {
    const getUsage = vi.fn(async (_note: string, anchor: string) => [host(`h-${anchor}`)])
    const hosts = await findBlockHosts(
      'src',
      [{ id: 'a', content: run('x ^aaaa'), children: [{ id: 'b', content: run('y ^bbbb') }] }],
      getUsage
    )
    expect(getUsage).toHaveBeenCalledTimes(2)
    expect(hosts.map((h) => h.noteId)).toEqual(['h-aaaa', 'h-bbbb'])
  })
})

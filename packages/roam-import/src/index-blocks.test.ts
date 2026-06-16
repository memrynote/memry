import { describe, it, expect } from 'vitest'
import { indexBlocks } from './index-blocks.ts'
import type { RoamPage } from './types.ts'

describe('indexBlocks', () => {
  it('indexes every block uid with its page title and text, recursively', () => {
    const pages: RoamPage[] = [
      {
        title: 'Page A',
        children: [
          {
            uid: 'a1',
            string: 'top a',
            children: [{ uid: 'a2', string: 'nested a' }]
          }
        ]
      },
      {
        title: 'Page B',
        children: [{ uid: 'b1', string: 'top b' }]
      }
    ]

    const index = indexBlocks(pages)

    expect(index.size).toBe(3)
    expect(index.get('a1')).toEqual({ pageTitle: 'Page A', text: 'top a' })
    expect(index.get('a2')).toEqual({ pageTitle: 'Page A', text: 'nested a' })
    expect(index.get('b1')).toEqual({ pageTitle: 'Page B', text: 'top b' })
  })

  it('handles pages with no children', () => {
    const index = indexBlocks([{ title: 'Empty' }])
    expect(index.size).toBe(0)
  })
})

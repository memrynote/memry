import { describe, expect, it } from 'vitest'
import { buildAzTagList } from './az-tags'
import type { HubTag } from '@/hooks/use-tag-categories'

const tag = (name: string, count = 1): HubTag => ({
  tag: name,
  color: 'blue',
  icon: null,
  count,
  sortOrder: 0
})

const names = (tags: HubTag[]): string[] => tags.map((t) => t.tag)

describe('buildAzTagList', () => {
  it('flattens every category and Uncategorized into one list', () => {
    const state = {
      categories: [
        { id: 'a', name: 'Work', sortOrder: 0, tags: [tag('meetings', 3), tag('okr')] },
        { id: 'b', name: 'Books', sortOrder: 1, tags: [tag('general')] },
        { id: 'c', name: 'Empty', sortOrder: 2, tags: [] }
      ],
      uncategorized: [tag('idea', 5)]
    }

    const result = buildAzTagList(state, '', 'en')

    expect(names(result)).toEqual(['general', 'idea', 'meetings', 'okr'])
    expect(result.find((t) => t.tag === 'meetings')?.count).toBe(3)
    expect(result.find((t) => t.tag === 'idea')?.count).toBe(5)
  })

  it('lists a tag that appears in more than one place once', () => {
    const state = {
      categories: [
        { id: 'a', name: 'Work', sortOrder: 0, tags: [tag('shared', 4)] },
        { id: 'b', name: 'Home', sortOrder: 1, tags: [tag('shared', 4), tag('chores')] }
      ],
      uncategorized: [tag('shared', 4)]
    }

    expect(names(buildAzTagList(state, '', 'en'))).toEqual(['chores', 'shared'])
  })

  it('sorts accents and case the way the locale expects, not by code point', () => {
    const state = {
      categories: [],
      uncategorized: [tag('Zebra'), tag('éclair'), tag('apple'), tag('Banana'), tag('eagle')]
    }

    // A code-point sort would put 'Banana' and 'Zebra' before every lowercase
    // tag and 'éclair' after 'eagle'.
    expect(names(buildAzTagList(state, '', 'fr'))).toEqual([
      'apple',
      'Banana',
      'eagle',
      'éclair',
      'Zebra'
    ])
  })

  it('follows the locale given: ö sorts with o in German but after z in Swedish', () => {
    const state = { categories: [], uncategorized: [tag('zebra'), tag('önskan'), tag('orange')] }

    expect(names(buildAzTagList(state, '', 'de'))).toEqual(['önskan', 'orange', 'zebra'])
    expect(names(buildAzTagList(state, '', 'sv'))).toEqual(['orange', 'zebra', 'önskan'])
  })

  it('orders numbers by value, not digit by digit', () => {
    const state = { categories: [], uncategorized: [tag('item 10'), tag('item 2'), tag('item 1')] }

    expect(names(buildAzTagList(state, '', 'en'))).toEqual(['item 1', 'item 2', 'item 10'])
  })

  it('keeps tags that differ only by case in a stable order', () => {
    const forward = { categories: [], uncategorized: [tag('Work'), tag('work')] }
    const backward = { categories: [], uncategorized: [tag('work'), tag('Work')] }

    expect(names(buildAzTagList(forward, '', 'en'))).toEqual(
      names(buildAzTagList(backward, '', 'en'))
    )
  })

  it('applies the search to tag names only, ignoring case', () => {
    const state = {
      categories: [
        { id: 'a', name: 'Work', sortOrder: 0, tags: [tag('meetings'), tag('Workshop')] },
        { id: 'b', name: 'Books', sortOrder: 1, tags: [tag('general')] }
      ],
      uncategorized: [tag('work-backlog'), tag('idea')]
    }

    // 'Work' the category matches the query, but its tag 'meetings' does not.
    expect(names(buildAzTagList(state, '  WORK ', 'en'))).toEqual(['work-backlog', 'Workshop'])
    expect(buildAzTagList(state, 'zzz', 'en')).toEqual([])
  })
})

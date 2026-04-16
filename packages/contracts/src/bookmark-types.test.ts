/**
 * Bookmark Types Contract Tests
 */

import { describe, it, expect } from 'vitest'
import { BookmarkItemTypes, type BookmarkItemType } from './bookmark-types'

describe('BookmarkItemTypes', () => {
  it('exposes the expected key/value map', () => {
    expect(BookmarkItemTypes).toEqual({
      NOTE: 'note',
      JOURNAL: 'journal',
      TASK: 'task',
      IMAGE: 'image',
      PDF: 'pdf',
      AUDIO: 'audio',
      VIDEO: 'video',
      CANVAS: 'canvas',
      FILE: 'file'
    })
  })

  it('type-checks all values', () => {
    const values: BookmarkItemType[] = [
      BookmarkItemTypes.NOTE,
      BookmarkItemTypes.JOURNAL,
      BookmarkItemTypes.TASK,
      BookmarkItemTypes.IMAGE,
      BookmarkItemTypes.PDF,
      BookmarkItemTypes.AUDIO,
      BookmarkItemTypes.VIDEO,
      BookmarkItemTypes.CANVAS,
      BookmarkItemTypes.FILE
    ]
    expect(values).toHaveLength(9)
  })

  it('values are unique lowercase strings', () => {
    const values = Object.values(BookmarkItemTypes)
    const uniqueValues = new Set(values)
    expect(uniqueValues.size).toBe(values.length)
    for (const v of values) {
      expect(v).toBe(v.toLowerCase())
    }
  })
})

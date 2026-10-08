import { describe, expect, test } from 'vitest'
import { matchTags } from './TagEditor'

describe('matchTags', () => {
  const vault = ['research', 'reading', 'ai', 'career', 'Recipes']

  test('ranks prefix matches before substring matches, case-insensitively', () => {
    expect(matchTags('re', vault, [])).toEqual(['research', 'reading', 'Recipes', 'career'])
  })

  test('skips tags already on the clip', () => {
    expect(matchTags('rea', vault, ['READING'])).toEqual([])
  })

  test('suggests nothing for an empty query', () => {
    expect(matchTags('  ', vault, [])).toEqual([])
  })
})

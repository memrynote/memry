import { describe, it, expect } from 'vitest'
import { inboxJobType } from './inbox.ts'

describe('inboxJobType', () => {
  it('includes the article-extract job type', () => {
    expect(inboxJobType.ARTICLE_EXTRACT).toBe('article-extract')
  })
})

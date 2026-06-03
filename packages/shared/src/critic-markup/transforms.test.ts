import { describe, expect, it } from 'vitest'
import {
  acceptCriticMark,
  deleteCriticMark,
  rejectCriticMark,
  resolveCriticMark
} from './transforms'
import type { CriticMarkupMark } from './parser'

const marks: CriticMarkupMark[] = [
  {
    id: 'add-1',
    kind: 'addition',
    visibleText: 'new',
    start: 6,
    end: 9
  },
  {
    id: 'del-1',
    kind: 'deletion',
    visibleText: 'old',
    originalText: 'old',
    start: 10,
    end: 13
  },
  {
    id: 'sub-1',
    kind: 'substitution',
    visibleText: 'right',
    originalText: 'wrong',
    start: 14,
    end: 19
  },
  {
    id: 'comment-1',
    kind: 'comment',
    visibleText: 'quote',
    body: 'body',
    start: 20,
    end: 25
  }
]

describe('CriticMarkup transforms', () => {
  it('accepts suggestions by keeping additions/substitutions and removing deletions', () => {
    expect(acceptCriticMark('Alpha new old right quote', marks, 'add-1')).toMatchObject({
      plainText: 'Alpha new old right quote',
      marks: expect.not.arrayContaining([expect.objectContaining({ id: 'add-1' })])
    })

    expect(acceptCriticMark('Alpha new old right quote', marks, 'del-1')).toMatchObject({
      plainText: 'Alpha new  right quote',
      marks: expect.not.arrayContaining([expect.objectContaining({ id: 'del-1' })])
    })

    expect(acceptCriticMark('Alpha new old right quote', marks, 'sub-1')).toMatchObject({
      plainText: 'Alpha new old right quote',
      marks: expect.not.arrayContaining([expect.objectContaining({ id: 'sub-1' })])
    })
  })

  it('rejects suggestions by removing additions, keeping deletions, and restoring substitutions', () => {
    expect(rejectCriticMark('Alpha new old right quote', marks, 'add-1')).toMatchObject({
      plainText: 'Alpha  old right quote'
    })

    expect(rejectCriticMark('Alpha new old right quote', marks, 'del-1')).toMatchObject({
      plainText: 'Alpha new old right quote'
    })

    expect(rejectCriticMark('Alpha new old right quote', marks, 'sub-1')).toMatchObject({
      plainText: 'Alpha new old wrong quote'
    })
  })

  it('resolves and deletes comment marks while keeping the commented text', () => {
    expect(resolveCriticMark('Alpha new old right quote', marks, 'comment-1')).toMatchObject({
      plainText: 'Alpha new old right quote',
      marks: expect.not.arrayContaining([expect.objectContaining({ id: 'comment-1' })])
    })

    expect(deleteCriticMark('Alpha new old right quote', marks, 'comment-1')).toMatchObject({
      plainText: 'Alpha new old right quote',
      marks: expect.not.arrayContaining([expect.objectContaining({ id: 'comment-1' })])
    })
  })
})

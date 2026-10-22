/** Verifier for `portal-resolve.json` (chapter 12 §12.6.3). */
import { describe, expect, it } from 'vitest'

import { parsePortalDefinition } from '@memry/shared/portal-block'
import { resolvePortal } from '@memry/shared/portal-resolve'
import { loadVectorFile } from './vector-loader'

interface Vectors {
  meta: { caseCount: number }
  cases: Array<{
    name: string
    definition: string
    blocks: Array<{ id: string; depth: number; inline: Array<{ text: string }> }>
    expectedStatus: string
    expectedIds: string[]
  }>
}

const vectors = loadVectorFile<Vectors>('portal-resolve.json')

describe('portal-resolve vectors', () => {
  it('carries the recorded case count', () => {
    expect(vectors.cases.length).toBe(vectors.meta.caseCount)
  })

  it.each(vectors.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const parsed = parsePortalDefinition(c.definition)
    if (!parsed.ok) throw new Error('definition must parse')
    const result = resolvePortal(parsed.definition, c.blocks)
    expect(result.status).toBe(c.expectedStatus)
    expect(result.blocks.map((b) => b.id)).toEqual(c.expectedIds)
  })
})

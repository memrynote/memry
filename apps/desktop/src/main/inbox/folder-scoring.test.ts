import { describe, it, expect } from 'vitest'
import { scoreFolders, type FolderHit } from './folder-scoring'

describe('scoreFolders', () => {
  it('ranks a clustered folder above a single-fluke folder', () => {
    // 'recipes' has three solid matches; 'misc' has one slightly-higher fluke.
    // The cluster should win — this is the core failure first-match-wins had.
    const hits: FolderHit[] = [
      { folder: 'recipes', similarity: 0.6 },
      { folder: 'recipes', similarity: 0.6 },
      { folder: 'recipes', similarity: 0.6 },
      { folder: 'misc', similarity: 0.7 }
    ]

    const scored = scoreFolders(hits)

    expect(scored[0]?.path).toBe('recipes')
    expect(scored[0]!.confidence).toBeGreaterThan(scored[1]!.confidence)
  })

  it('does not let a large mediocre folder beat a small excellent cluster', () => {
    // 10 weak hits in 'archive' vs 3 strong hits in 'recipes'.
    // Capped support must stop volume from winning (the popularity bias).
    const hits: FolderHit[] = [
      ...Array.from({ length: 10 }, () => ({ folder: 'archive', similarity: 0.45 })),
      { folder: 'recipes', similarity: 0.75 },
      { folder: 'recipes', similarity: 0.72 },
      { folder: 'recipes', similarity: 0.7 }
    ]

    const scored = scoreFolders(hits)

    expect(scored[0]?.path).toBe('recipes')
  })

  it('rolls evidence up to a common ancestor when sibling leaves split it', () => {
    // No single leaf dominates, but projects/ProjectA is clearly the home.
    const hits: FolderHit[] = [
      { folder: 'projects/ProjectA/sub1', similarity: 0.6 },
      { folder: 'projects/ProjectA/sub2', similarity: 0.6 },
      { folder: 'projects/ProjectA/sub3', similarity: 0.6 }
    ]

    const scored = scoreFolders(hits)
    const parent = scored.find((s) => s.path === 'projects/ProjectA')
    const leaf = scored.find((s) => s.path === 'projects/ProjectA/sub1')

    expect(parent).toBeDefined()
    expect(parent!.confidence).toBeGreaterThan(leaf!.confidence)
  })

  it('does not vacuum all evidence into the root folder', () => {
    // Two top-level folders each with a hit; root ('') must not collect both
    // and win — ancestor rollup stops before root.
    const hits: FolderHit[] = [
      { folder: 'recipes', similarity: 0.6 },
      { folder: 'travel', similarity: 0.6 }
    ]

    const scored = scoreFolders(hits)

    expect(scored.find((s) => s.path === '')).toBeUndefined()
  })
})

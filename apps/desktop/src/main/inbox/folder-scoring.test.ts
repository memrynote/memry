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

    const scored = scoreFolders({ hits })

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

    const scored = scoreFolders({ hits })

    expect(scored[0]?.path).toBe('recipes')
  })

  it('rolls evidence up to a common ancestor when sibling leaves split it', () => {
    // No single leaf dominates, but projects/ProjectA is clearly the home.
    const hits: FolderHit[] = [
      { folder: 'projects/ProjectA/sub1', similarity: 0.6 },
      { folder: 'projects/ProjectA/sub2', similarity: 0.6 },
      { folder: 'projects/ProjectA/sub3', similarity: 0.6 }
    ]

    const scored = scoreFolders({ hits })
    const parent = scored.find((s) => s.path === 'projects/ProjectA')
    const leaf = scored.find((s) => s.path === 'projects/ProjectA/sub1')

    expect(parent).toBeDefined()
    expect(parent!.confidence).toBeGreaterThan(leaf!.confidence)
  })

  it('does not vacuum all evidence into the root folder', () => {
    const hits: FolderHit[] = [
      { folder: 'recipes', similarity: 0.6 },
      { folder: 'travel', similarity: 0.6 }
    ]

    const scored = scoreFolders({ hits })

    expect(scored.find((s) => s.path === '')).toBeUndefined()
  })

  it('surfaces a folder matched only by name, even with zero similarity hits', () => {
    // Cold-start / folder-centric: the folder name itself is a signal.
    const scored = scoreFolders({
      hits: [],
      nameMatches: new Map([['recipes', 0.9]])
    })

    expect(scored[0]?.path).toBe('recipes')
    expect(scored[0]!.confidence).toBeGreaterThan(0.5)
  })

  it('lets a strong name match lift a folder above a same-similarity folder', () => {
    const scored = scoreFolders({
      hits: [
        { folder: 'recipes', similarity: 0.5 },
        { folder: 'misc', similarity: 0.5 }
      ],
      nameMatches: new Map([['recipes', 0.9]])
    })

    expect(scored[0]?.path).toBe('recipes')
  })

  it('blends member-tag overlap as a folder signal', () => {
    const scored = scoreFolders({
      hits: [],
      tagMatches: new Map([['cooking', 0.8]])
    })

    expect(scored[0]?.path).toBe('cooking')
    expect(scored[0]!.confidence).toBeGreaterThan(0.4)
  })

  it('excludes folders in the exclude set', () => {
    const scored = scoreFolders({
      hits: [
        { folder: 'recipes', similarity: 0.6 },
        { folder: 'current', similarity: 0.9 }
      ],
      exclude: ['current']
    })

    expect(scored.find((s) => s.path === 'current')).toBeUndefined()
    expect(scored[0]?.path).toBe('recipes')
  })

  it('caps results at limit', () => {
    const scored = scoreFolders({
      hits: [
        { folder: 'a', similarity: 0.6 },
        { folder: 'b', similarity: 0.55 },
        { folder: 'c', similarity: 0.5 }
      ],
      limit: 2
    })

    expect(scored).toHaveLength(2)
  })

  it('carries the best matching note title for reason text', () => {
    const scored = scoreFolders({
      hits: [
        { folder: 'recipes', similarity: 0.6, noteTitle: 'Pasta' },
        { folder: 'recipes', similarity: 0.8, noteTitle: 'Risotto' }
      ]
    })

    expect(scored[0]?.topNoteTitle).toBe('Risotto')
  })

  it('drops folders below the minimum confidence', () => {
    // Per-feature margin: folder suggestions get a floor; a lone weak hit is
    // suppressed while a strong cluster survives.
    const scored = scoreFolders({
      hits: [
        { folder: 'strong', similarity: 0.8 },
        { folder: 'strong', similarity: 0.8 },
        { folder: 'strong', similarity: 0.8 },
        { folder: 'weak', similarity: 0.5 }
      ],
      minConfidence: 0.5
    })

    expect(scored.find((s) => s.path === 'strong')).toBeDefined()
    expect(scored.find((s) => s.path === 'weak')).toBeUndefined()
  })

  it('returns nothing for no signals', () => {
    expect(scoreFolders({ hits: [] })).toEqual([])
  })
})

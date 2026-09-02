import { describe, expect, it, vi } from 'vitest'
import {
  diffLines,
  mergeMarkdownSource,
  readMarkdownSourceFromYDoc,
  restoreMarkdownSource,
  writeMarkdownSourceToYDoc,
  MAX_EDIT_DISTANCE
} from './markdown-source'

function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function lcsLength(a: string[], b: string[]): number {
  const row = new Array<number>(b.length + 1).fill(0)
  for (const line of a) {
    let diagonal = 0
    for (let j = 0; j < b.length; j++) {
      const above = row[j + 1]
      row[j + 1] = line === b[j] ? diagonal + 1 : Math.max(row[j + 1], row[j])
      diagonal = above
    }
  }
  return row[b.length]
}

function applyHunks(a: string[], b: string[]): string[] {
  const hunks = diffLines(a, b)
  if (!hunks) throw new Error('diff exceeded the edit-distance cap')
  const out: string[] = []
  let cursor = 0
  for (const hunk of hunks) {
    out.push(...a.slice(cursor, hunk.baseStart))
    out.push(...b.slice(hunk.sideStart, hunk.sideStart + hunk.sideLength))
    cursor = hunk.baseStart + hunk.baseLength
  }
  out.push(...a.slice(cursor))
  return out
}

describe('diffLines', () => {
  it('is a minimal edit script that rebuilds the target, across 2000 seeded pairs', () => {
    const random = seededRandom(0x1915)
    const alphabet = ['a', 'b', 'c', 'd']
    for (let i = 0; i < 2000; i++) {
      const lines = (): string[] =>
        Array.from(
          { length: Math.floor(random() * 12) },
          () => alphabet[Math.floor(random() * alphabet.length)]
        )
      const a = lines()
      const b = lines()
      const hunks = diffLines(a, b)
      expect(hunks, `diff of ${JSON.stringify(a)} vs ${JSON.stringify(b)}`).not.toBeNull()
      const matched = a.length - hunks!.reduce((sum, hunk) => sum + hunk.baseLength, 0)
      expect(matched, `matches for ${JSON.stringify(a)} vs ${JSON.stringify(b)}`).toBe(
        lcsLength(a, b)
      )
      expect(applyHunks(a, b)).toEqual(b)
    }
  })

  it('reports no hunk for identical input', () => {
    expect(diffLines(['a', 'b'], ['a', 'b'])).toEqual([])
  })

  it('gives up past the edit-distance cap instead of allocating for it', () => {
    const a = Array.from({ length: MAX_EDIT_DISTANCE + 2 }, (_, i) => `a${i}`)
    const b = Array.from({ length: MAX_EDIT_DISTANCE + 2 }, (_, i) => `b${i}`)
    expect(diffLines(a, b)).toBeNull()
  })
})

interface Seed {
  source: string
  /** What the source canonicalizes to, spelled out beside it. */
  canonical: string
}
const record = (source: string, canonical: string): Seed => ({ source, canonical })
const merge = (r: Seed, now: string): string | null =>
  mergeMarkdownSource(r.source, r.canonical, now)

/** A canonicalizer that knows the seed and whatever else the case teaches it. */
const canonicalizer = (
  r: Seed,
  more: Record<string, string | null> = {}
): ReturnType<typeof vi.fn> & ((md: string) => Promise<string | null>) =>
  vi.fn(async (md: string) =>
    md === r.source ? r.canonical : md in more ? more[md] : 'something else'
  )

describe('mergeMarkdownSource', () => {
  it('returns the source when the document has not changed', () => {
    const r = record('* One\n* Two', '- One\n- Two')
    expect(merge(r, '- One\n- Two')).toBe('* One\n* Two')
  })

  it('keeps the author’s spelling in the regions the edit did not touch', () => {
    const r = record(
      'Title\n=====\n\nText:\n* One\n* Two\n\n_em_ here.',
      '# Title\n\nText:\n\n- One\n- Two\n\n*em* here.'
    )
    const edited = '# Title\n\nText:\n\n- One\n- Two\n\n*em* here, edited.'
    expect(merge(r, edited)).toBe('Title\n=====\n\nText:\n* One\n* Two\n\n*em* here, edited.')
  })

  it('does not pair a blank line across a re-spelled list and write the list twice', () => {
    // A byte-minimal script may match the blank above the list in the base
    // with the blank below it in the source. That made `* One\n* Two` an
    // insertion and `- One\n- Two` a conflict, and the file got both.
    const r = record('Text:\n* One\n* Two\n\n_em_ here.', 'Text:\n\n- One\n- Two\n\n*em* here.')
    expect(merge(r, 'Text:\n\n- One\n- Two\n\n*em* here, edited.')).toBe(
      'Text:\n* One\n* Two\n\n*em* here, edited.'
    )
  })

  it('takes the whole re-spelled list into house style when an item is appended', () => {
    const r = record('Intro\n\n* One\n* Two\n\nOutro', 'Intro\n\n- One\n- Two\n\nOutro')
    const edited = 'Intro\n\n- One\n- Two\n- Three\n\nOutro'
    expect(merge(r, edited)).toBe(edited)
  })

  it('keeps a four-space nested list as written and adds the new child in house style', () => {
    const r = record('- a\n    - b\n\nAfter', '- a\n  - b\n\nAfter')
    const edited = '- a\n  - b\n    - c\n\nAfter'
    expect(merge(r, edited)).toBe(edited)
  })

  it('rewrites an edited setext heading whole, never orphaning its underline', () => {
    const r = record('Title\n=====\n\nBody', '# Title\n\nBody')
    expect(merge(r, '# New\n\nBody')).toBe('# New\n\nBody')
  })

  it('takes the shared change once when both sides made it', () => {
    const r = record('* One', '- One')
    expect(merge(r, '* One')).toBe('* One')
  })

  it('keeps a mid-file definition where the author put it and drops the lifted copy', () => {
    const r = record('Intro.\n\n[d]: /d\n\nSee [x][d].', 'Intro.\n\nSee [x][d].\n\n[d]: /d')
    expect(merge(r, 'Intro, edited.\n\nSee [x][d].\n\n[d]: /d')).toBe(
      'Intro, edited.\n\n[d]: /d\n\nSee [x][d].'
    )
  })

  it('returns null when a side is past the edit-distance cap', () => {
    const source = Array.from({ length: MAX_EDIT_DISTANCE + 2 }, (_, i) => `a${i}`).join('\n')
    const canonical = Array.from({ length: MAX_EDIT_DISTANCE + 2 }, (_, i) => `b${i}`).join('\n')
    expect(merge(record(source, canonical), `${canonical}\nmore`)).toBeNull()
  })

  it('aligns a re-spelled list line by line, so the cap is about content and not spelling', () => {
    const source = Array.from({ length: MAX_EDIT_DISTANCE + 2 }, (_, i) => `* ${i}`).join('\n')
    const canonical = Array.from({ length: MAX_EDIT_DISTANCE + 2 }, (_, i) => `- ${i}`).join('\n')
    expect(merge(record(source, canonical), canonical)).toBe(source)
  })
})

describe('restoreMarkdownSource', () => {
  it('is the canonical text when nothing was recorded', async () => {
    const canonicalize = vi.fn()
    expect(await restoreMarkdownSource('- One', null, canonicalize)).toBe('- One')
    expect(canonicalize).not.toHaveBeenCalled()
  })

  it('derives the base from the source and returns the source when the document has not changed', async () => {
    const r = record('* One', '- One')
    const canonicalize = canonicalizer(r)
    expect(await restoreMarkdownSource('- One', r.source, canonicalize)).toBe('* One')
    expect(canonicalize).toHaveBeenCalledTimes(1)
    expect(canonicalize).toHaveBeenCalledWith('* One')
  })

  it('is house style when the source no longer parses', async () => {
    expect(await restoreMarkdownSource('- One', '* One', async () => null)).toBe('- One')
  })

  it('writes the merge only when it re-parses to what the document says', async () => {
    const r = record('Intro.\n\nText:\n* One\n* Two', 'Intro.\n\nText:\n\n- One\n- Two')
    const edited = 'Intro, edited.\n\nText:\n\n- One\n- Two'
    const merged = 'Intro, edited.\n\nText:\n* One\n* Two'
    const canonicalize = canonicalizer(r, { [merged]: edited })
    expect(await restoreMarkdownSource(edited, r.source, canonicalize)).toBe(merged)
    expect(canonicalize).toHaveBeenLastCalledWith(merged)
  })

  it('takes the glued block into house style when the line before a re-spelled list is edited', async () => {
    // No stable line separates `Text:` from the list the source glued to it,
    // so the edit and the re-spelling are one region and house style wins.
    const r = record('Text:\n* One\n* Two', 'Text:\n\n- One\n- Two')
    const edited = 'Text, edited:\n\n- One\n- Two'
    const canonicalize = canonicalizer(r)
    expect(await restoreMarkdownSource(edited, r.source, canonicalize)).toBe(edited)
    expect(canonicalize).toHaveBeenCalledTimes(1)
  })

  it('ignores a trailing gap the open editor adds after the last block', async () => {
    // BlockNote keeps an empty trailing paragraph while a note is open; it
    // serializes as `\n\n\n` after the body and no file ever holds it.
    const r = record('* One\n\nPara', '- One\n\nPara')
    const canonicalize = canonicalizer(r, { '* One\n\nPara, edited.': '- One\n\nPara, edited.' })
    expect(await restoreMarkdownSource('- One\n\nPara\n\n\n', r.source, canonicalize)).toBe(
      '* One\n\nPara'
    )
    expect(canonicalize).toHaveBeenCalledTimes(1)
    expect(
      await restoreMarkdownSource('- One\n\nPara, edited.\n\n\n', r.source, canonicalize)
    ).toBe('* One\n\nPara, edited.')
  })

  it('falls back to house style when the merge means something else', async () => {
    // The author's list is glued to its paragraph. Emptying the only item
    // leaves `Text:\n-`, which is one paragraph, not a list — the reviewer's
    // case for why the merge cannot be trusted unproven.
    const r = record('Text:\n- Item', 'Text:\n\n- Item')
    const edited = 'Text:\n\n-'
    const canonicalize = canonicalizer(r, { 'Text:\n-': 'Text:\n-' })
    expect(await restoreMarkdownSource(edited, r.source, canonicalize)).toBe(edited)
  })

  it('falls back to house style when the proof parse fails', async () => {
    const r = record('* One\n\nPara', '- One\n\nPara')
    expect(
      await restoreMarkdownSource(
        '- One\n\nPara!',
        r.source,
        canonicalizer(r, { '* One\n\nPara!': null })
      )
    ).toBe('- One\n\nPara!')
  })

  it('skips the proof when the merge is already house style', async () => {
    const r = record('* One', '- One')
    const canonicalize = canonicalizer(r)
    expect(await restoreMarkdownSource('- Two', r.source, canonicalize)).toBe('- Two')
    expect(canonicalize).toHaveBeenCalledTimes(1)
  })
})

function fakeDoc(): {
  getMap: (name: string) => Map<string, unknown>
  maps: Map<string, Map<string, unknown>>
} {
  const maps = new Map<string, Map<string, unknown>>()
  return {
    maps,
    getMap: (name) => {
      let map = maps.get(name)
      if (!map) {
        map = new Map()
        maps.set(name, map)
      }
      return map
    }
  }
}

describe('shared-doc channel', () => {
  it('clearing an empty channel writes nothing', () => {
    const doc = fakeDoc()
    writeMarkdownSourceToYDoc(doc, null)
    expect(readMarkdownSourceFromYDoc(doc)).toBeNull()
    expect(doc.maps.get('markdownSource')!.size).toBe(0)
  })

  it('round-trips the source under one key and clears it on request', () => {
    const doc = fakeDoc()
    writeMarkdownSourceToYDoc(doc, '* One')
    expect(readMarkdownSourceFromYDoc(doc)).toBe('* One')
    expect([...doc.maps.get('markdownSource')!.keys()]).toEqual(['record'])
    writeMarkdownSourceToYDoc(doc, null)
    expect(readMarkdownSourceFromYDoc(doc)).toBeNull()
  })

  it('does not rewrite an identical source', () => {
    const doc = fakeDoc()
    writeMarkdownSourceToYDoc(doc, '* One')
    const map = doc.maps.get('markdownSource')!
    const set = vi.spyOn(map, 'set')
    writeMarkdownSourceToYDoc(doc, '* One')
    expect(set).not.toHaveBeenCalled()
  })

  it('reads a malformed record as absent', () => {
    const doc = fakeDoc()
    doc.getMap('markdownSource').set('record', { source: 1 })
    expect(readMarkdownSourceFromYDoc(doc)).toBeNull()
    doc.getMap('markdownSource').set('record', 'nope')
    expect(readMarkdownSourceFromYDoc(doc)).toBeNull()
  })
})

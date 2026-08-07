import { describe, expect, it } from 'vitest'
import {
  MAX_CANVAS_FOLDER_DEPTH,
  folderSegments,
  isDescendantFolder,
  joinFolder,
  normalizeFolder,
  parentFolder,
  rewriteFolderPrefix
} from './folder-paths'

/** Exactly at the cap, and one segment past it. */
const AT_CAP = Array.from({ length: MAX_CANVAS_FOLDER_DEPTH }, (_, i) => `d${i + 1}`).join('/')
const PAST_CAP = `${AT_CAP}/d${MAX_CANVAS_FOLDER_DEPTH + 1}`

describe('normalizeFolder', () => {
  it('treats empty-ish values as root', () => {
    expect(normalizeFolder(null)).toBeNull()
    expect(normalizeFolder(undefined)).toBeNull()
    expect(normalizeFolder('')).toBeNull()
    expect(normalizeFolder('   ')).toBeNull()
    expect(normalizeFolder('.')).toBeNull()
    expect(normalizeFolder('/')).toBeNull()
  })

  it('strips and collapses slashes', () => {
    expect(normalizeFolder('/Work/')).toBe('Work')
    expect(normalizeFolder('Work//Q3')).toBe('Work/Q3')
  })

  it('drops traversal segments, so the canonical form never carries one', () => {
    expect(normalizeFolder('..')).toBeNull()
    expect(normalizeFolder('../..')).toBeNull()
    expect(normalizeFolder('Work/..')).toBe('Work')
    expect(normalizeFolder('../../etc')).toBe('etc')
  })

  it('refuses a folder nested past the depth every canvas walk stops at', () => {
    expect(normalizeFolder(AT_CAP)).toBe(AT_CAP)
    expect(() => normalizeFolder(PAST_CAP)).toThrow(/deeper than/)
  })
})

describe('joinFolder', () => {
  it('joins onto root and onto a parent', () => {
    expect(joinFolder(null, 'Work')).toBe('Work')
    expect(joinFolder('Work', 'Q3')).toBe('Work/Q3')
  })

  it('refuses a traversal segment as a name', () => {
    expect(() => joinFolder('Work', '..')).toThrow(/cannot be empty/)
  })

  it('refuses a join that would land past the depth cap', () => {
    const parent = AT_CAP.split('/').slice(0, -1).join('/')
    expect(joinFolder(parent, `d${MAX_CANVAS_FOLDER_DEPTH}`)).toBe(AT_CAP)
    expect(() => joinFolder(AT_CAP, 'deeper')).toThrow(/deeper than/)
  })
})

describe('parentFolder', () => {
  it('walks up one level', () => {
    expect(parentFolder('Work/Q3')).toBe('Work')
    expect(parentFolder('Work')).toBeNull()
    expect(parentFolder(null)).toBeNull()
  })
})

describe('isDescendantFolder', () => {
  it('matches self and descendants', () => {
    expect(isDescendantFolder('Work', 'Work')).toBe(true)
    expect(isDescendantFolder('Work/Q3', 'Work')).toBe(true)
    expect(isDescendantFolder('Work/Q3/Deep', 'Work')).toBe(true)
  })

  it('rejects siblings and unrelated folders', () => {
    expect(isDescendantFolder('Workshop', 'Work')).toBe(false)
    expect(isDescendantFolder('Personal', 'Work')).toBe(false)
    expect(isDescendantFolder('Work', 'Work/Q3')).toBe(false)
  })

  it('treats every folder as a descendant of root', () => {
    expect(isDescendantFolder('Work/Q3', null)).toBe(true)
    expect(isDescendantFolder(null, null)).toBe(true)
  })

  it('compares case-insensitively', () => {
    expect(isDescendantFolder('work/q3', 'Work')).toBe(true)
  })

  it('treats the NFD and NFC spellings of a segment as one folder (macOS stores NFD)', () => {
    const composed = 'Yağmur'.normalize('NFC')
    const decomposed = 'Yağmur'.normalize('NFD')
    // Same folder to the user, different bytes on disk.
    expect(composed).not.toBe(decomposed)

    expect(isDescendantFolder(`${decomposed}/Q3`, composed)).toBe(true)
    expect(isDescendantFolder(composed, decomposed)).toBe(true)
    // Case and normalization together — a Mac readdir gives NFD, the app NFC.
    expect(isDescendantFolder(decomposed.toUpperCase(), composed)).toBe(true)
  })
})

describe('rewriteFolderPrefix', () => {
  it('rewrites the folder itself and its descendants', () => {
    expect(rewriteFolderPrefix('Work', 'Work', 'Job')).toBe('Job')
    expect(rewriteFolderPrefix('Work/Q3', 'Work', 'Job')).toBe('Job/Q3')
  })

  it('leaves unrelated folders alone, including prefix lookalikes', () => {
    expect(rewriteFolderPrefix('Workshop', 'Work', 'Job')).toBe('Workshop')
    expect(rewriteFolderPrefix(null, 'Work', 'Job')).toBeNull()
  })

  it('refuses an empty source rather than re-rooting every folder in the vault', () => {
    // Every folder is a descendant of the root, so an empty `from` would move
    // the whole vault under `to` in one call.
    expect(() => rewriteFolderPrefix('Work/Q3', '', 'Job')).toThrow(/source folder/)
    expect(() => rewriteFolderPrefix('Work/Q3', '   ', 'Job')).toThrow(/source folder/)
    expect(() => rewriteFolderPrefix('Work/Q3', '.', 'Job')).toThrow(/source folder/)
  })

  it('refuses a rewrite that would land past the depth cap', () => {
    expect(rewriteFolderPrefix('Work', 'Work', AT_CAP)).toBe(AT_CAP)
    expect(() => rewriteFolderPrefix('Work/Q3', 'Work', AT_CAP)).toThrow(/deeper than/)
  })
})

describe('folderSegments', () => {
  it('splits a folder into its parts', () => {
    expect(folderSegments('Work/Q3')).toEqual(['Work', 'Q3'])
    expect(folderSegments(null)).toEqual([])
  })
})

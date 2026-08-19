import { describe, expect, it } from 'vitest'

import { generateBulkVault } from './bulk-notes'

describe('bulk note generator', () => {
  const vault = generateBulkVault(120, 42)

  it('generates the requested number of notes with unique paths and ids', () => {
    expect(vault.notes).toHaveLength(120)
    expect(new Set(vault.notes.map((n) => n.path)).size).toBe(120)
    expect(new Set(vault.notes.map((n) => n.id)).size).toBe(120)
    for (const note of vault.notes) {
      expect(note.id).toMatch(/^[0-9a-z]{12}$/)
      expect(note.path).toMatch(/^[a-z]+\/.+\.md$/)
    }
  })

  it('is deterministic for a given seed', () => {
    const again = generateBulkVault(120, 42)
    expect(again.notes.map((n) => n.file.body)).toEqual(vault.notes.map((n) => n.file.body))

    const different = generateBulkVault(120, 43)
    expect(different.notes.map((n) => n.title)).not.toEqual(vault.notes.map((n) => n.title))
  })

  it('writes substantial bodies — never empty notes', () => {
    for (const note of vault.notes) {
      expect(note.file.body.length).toBeGreaterThan(800)
    }
  })

  it('gives every note the structure the editor and index care about', () => {
    for (const note of vault.notes) {
      const body = note.file.body
      expect(body).toContain('## Context')
      expect(body).toContain('| Item | Owner | State |')
      expect(body).toContain('- [ ]')
      expect(body).toContain('[[')
      expect(body).toMatch(/^> \[!/m)
      expect(body).toMatch(/#\w/)
    }
  })

  it('keeps Memry-owned keys out of frontmatter, like the demo seed', () => {
    for (const note of vault.notes) {
      const frontmatter = note.file.frontmatter
      expect(frontmatter.id).toBeUndefined()
      expect(frontmatter.title).toBeUndefined()
      expect(frontmatter.created).toBeUndefined()
      expect(frontmatter.modified).toBeUndefined()
      expect(Array.isArray(frontmatter.tags)).toBe(true)
      expect(note.file.modified).toBe(note.modifiedAt)
    }
  })

  it('dates every note in the past, modified at or after created', () => {
    const now = Date.now()
    for (const note of vault.notes) {
      const created = Date.parse(note.createdAt)
      const modified = Date.parse(note.modifiedAt)
      expect(created).toBeLessThanOrEqual(now)
      expect(modified).toBeLessThanOrEqual(now)
      expect(modified).toBeGreaterThanOrEqual(created)
    }
  })

  it('reports the folders and tags actually used', () => {
    const usedFolders = new Set(vault.notes.map((n) => n.path.split('/')[0]))
    expect(new Set(vault.folders.map((f) => f.path))).toEqual(usedFolders)

    const usedTags = new Set(vault.notes.flatMap((n) => n.tags))
    expect(new Set(vault.tags)).toEqual(usedTags)
  })
})

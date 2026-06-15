import { describe, it, expect } from 'vitest'
import { parseFrontmatter } from './parse-frontmatter.ts'

describe('parseFrontmatter', () => {
  it('returns empty tags + empty properties for plain body', () => {
    const result = parseFrontmatter('# Hello\n\nsome text')
    expect(result.tags).toEqual([])
    expect(result.properties).toEqual({})
    expect(result.title).toBeUndefined()
    expect(result.body.trim()).toBe('# Hello\n\nsome text')
  })

  it('lifts title from frontmatter', () => {
    const src = '---\ntitle: My Note\n---\nbody text'
    const result = parseFrontmatter(src)
    expect(result.title).toBe('My Note')
    expect(result.properties).not.toHaveProperty('title')
    expect(result.body.trim()).toBe('body text')
  })

  it('lifts tags array from frontmatter', () => {
    const src = '---\ntags:\n  - work\n  - home\n---\nbody'
    const result = parseFrontmatter(src)
    expect(result.tags).toEqual(['work', 'home'])
    expect(result.properties).not.toHaveProperty('tags')
  })

  it('normalises single string tag', () => {
    const src = '---\ntags: project\n---\nbody'
    const result = parseFrontmatter(src)
    expect(result.tags).toEqual(['project'])
  })

  it('keeps remaining frontmatter keys as properties', () => {
    const src = '---\ntitle: T\nstatus: done\npriority: 1\n---\nbody'
    const result = parseFrontmatter(src)
    expect(result.properties).toEqual({ status: 'done', priority: 1 })
  })

  it('handles no frontmatter at all', () => {
    const result = parseFrontmatter('just a body')
    expect(result.tags).toEqual([])
    expect(result.title).toBeUndefined()
    expect(result.body.trim()).toBe('just a body')
  })
})

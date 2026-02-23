import { describe, it, expect } from 'vitest'
import path from 'path'
import {
  sanitizePath,
  getRelativePath,
  isPathInVault,
  safeFileName,
  isMarkdownFile,
  getTitleFromPath,
  safeJoin,
  ensureMarkdownExtension,
  toMemryFileUrl,
  fromMemryFileUrl
} from './paths'

describe('paths utils', () => {
  it('sanitizePath removes traversal segments', () => {
    const input = path.join('..', 'vault', '..', 'note.md')
    const sanitized = sanitizePath(input)
    expect(sanitized.split(path.sep)).not.toContain('..')
    expect(sanitized).toBe(path.join('note.md'))
  })

  it('getRelativePath returns relative path for files inside the vault', () => {
    const vaultRoot = path.join(process.cwd(), 'vault-root')
    const inside = path.join(vaultRoot, 'notes', 'note.md')
    expect(getRelativePath(vaultRoot, inside)).toBe(path.join('notes', 'note.md'))
  })

  it('getRelativePath returns null for files outside the vault', () => {
    const vaultRoot = path.join(process.cwd(), 'vault-root')
    const outside = path.join(process.cwd(), 'outside', 'note.md')
    expect(getRelativePath(vaultRoot, outside)).toBeNull()
  })

  it('isPathInVault confirms whether a file is within the vault', () => {
    const vaultRoot = path.join(process.cwd(), 'vault-root')
    const inside = path.join(vaultRoot, 'notes', 'note.md')
    const outside = path.join(process.cwd(), 'outside', 'note.md')
    expect(isPathInVault(vaultRoot, inside)).toBe(true)
    expect(isPathInVault(vaultRoot, outside)).toBe(false)
  })

  it('safeFileName sanitizes special characters and trims to a fallback', () => {
    expect(safeFileName('  My:* Note  ')).toBe('My-Note')
    expect(safeFileName('***')).toBe('untitled')
  })

  it('isMarkdownFile recognizes .md and .markdown extensions', () => {
    expect(isMarkdownFile('note.md')).toBe(true)
    expect(isMarkdownFile('note.markdown')).toBe(true)
    expect(isMarkdownFile('note.txt')).toBe(false)
  })

  it('getTitleFromPath extracts filename without extension', () => {
    expect(getTitleFromPath('/notes/project-plan.md')).toBe('project-plan')
  })

  it('safeJoin prevents joining paths outside the base directory', () => {
    const base = path.join(process.cwd(), 'vault-root')
    const safe = safeJoin(base, 'notes', 'note.md')
    const unsafe = safeJoin(base, '..', 'escape.md')
    expect(safe).toBe(path.join(base, 'notes', 'note.md'))
    expect(unsafe).toBeNull()
  })

  it('ensureMarkdownExtension adds .md when missing', () => {
    expect(ensureMarkdownExtension('note')).toBe('note.md')
    expect(ensureMarkdownExtension('note.md')).toBe('note.md')
    expect(ensureMarkdownExtension('note.markdown')).toBe('note.markdown')
  })

  it('toMemryFileUrl builds a memry-file URL for the platform', () => {
    if (process.platform === 'win32') {
      expect(toMemryFileUrl('C:\\vault\\note.md')).toBe('memry-file://local/C:/vault/note.md')
    } else {
      expect(toMemryFileUrl('/vault/note.md')).toBe('memry-file://local/vault/note.md')
    }
  })

  it('fromMemryFileUrl reverses toMemryFileUrl', () => {
    if (process.platform === 'win32') {
      expect(fromMemryFileUrl('memry-file://local/C:/vault/note.md')).toBe('C:/vault/note.md')
    } else {
      expect(fromMemryFileUrl('memry-file://local/vault/note.md')).toBe('/vault/note.md')
    }
  })

  it('fromMemryFileUrl throws on invalid URL', () => {
    expect(() => fromMemryFileUrl('file:///some/path')).toThrow('Invalid memry-file URL')
    expect(() => fromMemryFileUrl('https://example.com')).toThrow('Invalid memry-file URL')
  })

  it('fromMemryFileUrl roundtrips with toMemryFileUrl', () => {
    const original = '/Users/test/vault/attachments/abc/image.png'
    const url = toMemryFileUrl(original)
    const restored = fromMemryFileUrl(url)
    expect(restored).toBe(original)
  })
})

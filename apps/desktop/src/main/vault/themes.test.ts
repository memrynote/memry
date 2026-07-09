import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { CustomTheme } from '@memry/contracts/themes-api'
import {
  getThemesDirPath,
  slugifyThemeName,
  uniqueThemeSlug,
  listThemeFiles,
  readThemeFile,
  writeThemeFile,
  renameThemeFile,
  deleteThemeFile
} from './themes'

let vaultPath: string

const theme = (overrides: Partial<CustomTheme> = {}): CustomTheme => ({
  id: 'theme-id-1',
  name: 'Tema 1',
  base: 'light',
  variables: { '--background': '#f6f5f0' },
  createdAt: '2026-07-09T10:00:00.000Z',
  modifiedAt: '2026-07-09T10:00:00.000Z',
  ...overrides
})

beforeEach(() => {
  vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-themes-test-'))
})

afterEach(() => {
  fs.rmSync(vaultPath, { recursive: true, force: true })
})

describe('slugifyThemeName', () => {
  it('lowercases and dashes whitespace', () => {
    expect(slugifyThemeName('Tema 1')).toBe('tema-1')
  })

  it('strips punctuation and collapses separators', () => {
    expect(slugifyThemeName('  My *Theme*  ')).toBe('my-theme')
  })

  it('falls back to "theme" when nothing survives', () => {
    expect(slugifyThemeName('###')).toBe('theme')
  })
})

describe('uniqueThemeSlug', () => {
  it('returns the plain slug when free', () => {
    expect(uniqueThemeSlug('Tema 1', new Set())).toBe('tema-1')
  })

  it('suffixes -2, -3… on collisions', () => {
    expect(uniqueThemeSlug('Tema 1', new Set(['tema-1']))).toBe('tema-1-2')
    expect(uniqueThemeSlug('Tema 1', new Set(['tema-1', 'tema-1-2']))).toBe('tema-1-3')
  })
})

describe('theme file CRUD', () => {
  it('writes and reads a theme back', () => {
    writeThemeFile(vaultPath, 'tema-1', theme())
    const loaded = readThemeFile(vaultPath, 'tema-1')
    expect(loaded).toEqual(theme())
    expect(fs.existsSync(path.join(getThemesDirPath(vaultPath), 'tema-1.json'))).toBe(true)
  })

  it('returns null for a missing theme', () => {
    expect(readThemeFile(vaultPath, 'nope')).toBeNull()
  })

  it('returns null for a corrupt file', () => {
    const dir = getThemesDirPath(vaultPath)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'broken.json'), '{not json', 'utf-8')
    expect(readThemeFile(vaultPath, 'broken')).toBeNull()
  })

  it('sanitizes invalid variables on read (forward compatibility)', () => {
    writeThemeFile(
      vaultPath,
      'tema-1',
      theme({
        variables: {
          '--background': '#f6f5f0',
          '--future': 'color-mix(in srgb, red, blue)',
          notAVar: '#111111'
        }
      })
    )
    const loaded = readThemeFile(vaultPath, 'tema-1')
    expect(loaded?.variables).toEqual({ '--background': '#f6f5f0' })
  })

  it('lists themes with their slugs, skipping corrupt files', () => {
    writeThemeFile(vaultPath, 'tema-1', theme())
    writeThemeFile(vaultPath, 'tema-2', theme({ id: 'theme-id-2', name: 'Tema 2', base: 'dark' }))
    fs.writeFileSync(path.join(getThemesDirPath(vaultPath), 'broken.json'), 'nope', 'utf-8')

    const listed = listThemeFiles(vaultPath)
    expect(listed.map((entry) => entry.slug).sort()).toEqual(['tema-1', 'tema-2'])
    expect(listed.find((entry) => entry.slug === 'tema-2')?.theme.base).toBe('dark')
  })

  it('returns empty list when the themes dir does not exist', () => {
    expect(listThemeFiles(vaultPath)).toEqual([])
  })

  it('renames a theme file', () => {
    writeThemeFile(vaultPath, 'tema-1', theme())
    renameThemeFile(vaultPath, 'tema-1', 'renamed')
    expect(readThemeFile(vaultPath, 'tema-1')).toBeNull()
    expect(readThemeFile(vaultPath, 'renamed')?.id).toBe('theme-id-1')
  })

  it('deletes a theme file and tolerates deleting a missing one', () => {
    writeThemeFile(vaultPath, 'tema-1', theme())
    deleteThemeFile(vaultPath, 'tema-1')
    expect(readThemeFile(vaultPath, 'tema-1')).toBeNull()
    expect(() => deleteThemeFile(vaultPath, 'tema-1')).not.toThrow()
  })
})

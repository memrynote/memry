/**
 * Tests for obsidian-config.ts
 * Read-only accessors for `.obsidian/` and the property-type holder.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  hasObsidianDir,
  readDailyNotesConfig,
  readAppConfig,
  readPropertyTypes,
  mapObsidianType,
  loadObsidianPropertyTypes,
  getObsidianPropertyType
} from './obsidian-config'
import { inferPropertyType } from './frontmatter'
import { inferPropertyType as inferPropertyTypeDb } from '../database/queries/notes/query-helpers'

let vaultPath: string

function writeObsidianFile(file: string, content: string): void {
  const dir = path.join(vaultPath, '.obsidian')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, file), content)
}

beforeEach(() => {
  vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-config-test-'))
})

afterEach(() => {
  fs.rmSync(vaultPath, { recursive: true, force: true })
  // Vault is gone → reload clears the process-wide holder
  loadObsidianPropertyTypes(vaultPath)
})

describe('hasObsidianDir', () => {
  it('returns false without .obsidian and true with it', () => {
    expect(hasObsidianDir(vaultPath)).toBe(false)
    fs.mkdirSync(path.join(vaultPath, '.obsidian'))
    expect(hasObsidianDir(vaultPath)).toBe(true)
  })

  it('returns false when .obsidian is a file', () => {
    fs.writeFileSync(path.join(vaultPath, '.obsidian'), 'not a dir')
    expect(hasObsidianDir(vaultPath)).toBe(false)
  })
})

describe('readDailyNotesConfig', () => {
  it('reads folder, format and template', () => {
    writeObsidianFile(
      'daily-notes.json',
      JSON.stringify({ folder: 'Daily Notes', format: 'YYYY-MM-DD', template: 'tpl.md' })
    )
    expect(readDailyNotesConfig(vaultPath)).toEqual({
      folder: 'Daily Notes',
      format: 'YYYY-MM-DD',
      template: 'tpl.md'
    })
  })

  it('returns null for missing folder, missing file and malformed JSON', () => {
    expect(readDailyNotesConfig(vaultPath)).toBeNull()
    fs.mkdirSync(path.join(vaultPath, '.obsidian'))
    expect(readDailyNotesConfig(vaultPath)).toBeNull()
    writeObsidianFile('daily-notes.json', '{ not json')
    expect(readDailyNotesConfig(vaultPath)).toBeNull()
  })

  it('drops non-string values', () => {
    writeObsidianFile('daily-notes.json', JSON.stringify({ folder: 42, format: 'YYYY-MM-DD' }))
    expect(readDailyNotesConfig(vaultPath)).toEqual({ format: 'YYYY-MM-DD' })
  })

  it('never reads workspace.json', () => {
    writeObsidianFile('workspace.json', JSON.stringify({ folder: 'from-workspace' }))
    expect(readDailyNotesConfig(vaultPath)).toBeNull()
    expect(readAppConfig(vaultPath)).toBeNull()
    expect(readPropertyTypes(vaultPath)).toBeNull()
  })
})

describe('readAppConfig', () => {
  it('reads attachment and link preferences', () => {
    writeObsidianFile(
      'app.json',
      JSON.stringify({
        attachmentFolderPath: './assets',
        newLinkFormat: 'relative',
        useMarkdownLinks: true
      })
    )
    expect(readAppConfig(vaultPath)).toEqual({
      attachmentFolderPath: './assets',
      newLinkFormat: 'relative',
      useMarkdownLinks: true
    })
  })

  it('drops invalid newLinkFormat values and returns null on malformed JSON', () => {
    writeObsidianFile('app.json', JSON.stringify({ newLinkFormat: 'bogus' }))
    expect(readAppConfig(vaultPath)).toEqual({})
    writeObsidianFile('app.json', 'nope')
    expect(readAppConfig(vaultPath)).toBeNull()
  })
})

describe('readPropertyTypes', () => {
  it('reads known types keyed by lowercased name, dropping unknown values', () => {
    writeObsidianFile(
      'types.json',
      JSON.stringify({
        types: {
          Priority: 'number',
          due: 'date',
          done: 'checkbox',
          people: 'multitext',
          tags: 'tags',
          weird: 'nonsense'
        }
      })
    )
    expect(readPropertyTypes(vaultPath)).toEqual({
      priority: 'number',
      due: 'date',
      done: 'checkbox',
      people: 'multitext',
      tags: 'tags'
    })
  })

  it('returns null when types key is missing or malformed', () => {
    writeObsidianFile('types.json', JSON.stringify({ other: true }))
    expect(readPropertyTypes(vaultPath)).toBeNull()
    writeObsidianFile('types.json', JSON.stringify({ types: [1, 2] }))
    expect(readPropertyTypes(vaultPath)).toBeNull()
  })
})

describe('mapObsidianType', () => {
  it('maps Obsidian types to Memry property types', () => {
    expect(mapObsidianType('text')).toBe('text')
    expect(mapObsidianType('number')).toBe('number')
    expect(mapObsidianType('checkbox')).toBe('checkbox')
    expect(mapObsidianType('date')).toBe('date')
    expect(mapObsidianType('datetime')).toBe('date')
    expect(mapObsidianType('multitext')).toBe('multiselect')
    expect(mapObsidianType('tags')).toBeNull()
  })
})

describe('property-type holder + inference order', () => {
  beforeEach(() => {
    writeObsidianFile(
      'types.json',
      JSON.stringify({ types: { priority: 'number', tags: 'tags', when: 'datetime' } })
    )
    loadObsidianPropertyTypes(vaultPath)
  })

  it('getObsidianPropertyType is name-based and case-insensitive', () => {
    expect(getObsidianPropertyType('priority')).toBe('number')
    expect(getObsidianPropertyType('Priority')).toBe('number')
    expect(getObsidianPropertyType('when')).toBe('date')
    expect(getObsidianPropertyType('tags')).toBeNull() // reserved, mapped to null
    expect(getObsidianPropertyType('unlisted')).toBeNull()
  })

  it('types.json wins over value inference, value inference is the fallback', () => {
    expect(inferPropertyType('priority', 'not a number')).toBe('number')
    expect(inferPropertyType('unlisted', true)).toBe('checkbox')
    expect(inferPropertyTypeDb('priority', 'not a number')).toBe('number')
    expect(inferPropertyTypeDb('unlisted', 'https://example.com')).toBe('url')
  })

  it('reloading from a vault without .obsidian clears the holder', () => {
    const emptyVault = fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-config-empty-'))
    try {
      loadObsidianPropertyTypes(emptyVault)
      expect(getObsidianPropertyType('priority')).toBeNull()
    } finally {
      fs.rmSync(emptyVault, { recursive: true, force: true })
    }
  })
})

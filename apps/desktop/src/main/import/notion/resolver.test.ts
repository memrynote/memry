import { describe, it, expect } from 'vitest'
import { NotionResolverInfo } from './resolver'

const ID_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const ID_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

describe('NotionResolverInfo', () => {
  it('builds a nested folder path from parent ids', () => {
    const info = new NotionResolverInfo()
    info.idsToFileInfo[ID_A] = {
      path: `Parent ${ID_A}.html`,
      parentIds: [],
      title: 'Parent',
      ctime: null,
      mtime: null
    }
    info.idsToFileInfo[ID_B] = {
      path: `Parent ${ID_A}/Child ${ID_B}.html`,
      parentIds: [ID_A],
      title: 'Child',
      ctime: null,
      mtime: null
    }
    expect(info.getPathForFile(info.idsToFileInfo[ID_B])).toBe('Parent/')
  })

  it('falls back to folder structure with stripped ids when no parentIds', () => {
    const info = new NotionResolverInfo()
    const fileInfo = {
      path: `Notes ${ID_A}/Note ${ID_B}.html`,
      parentIds: [],
      title: 'Note',
      ctime: null,
      mtime: null
    }
    expect(info.getPathForFile(fileInfo)).toBe('Notes/')
  })

  it('returns empty path for a root-level page', () => {
    const info = new NotionResolverInfo()
    const fileInfo = {
      path: `Root ${ID_A}.html`,
      parentIds: [],
      title: 'Root',
      ctime: null,
      mtime: null
    }
    expect(info.getPathForFile(fileInfo)).toBe('')
  })

  it('de-duplicates colliding titles and flags full-link-needed', () => {
    const info = new NotionResolverInfo()
    info.idsToFileInfo[ID_A] = {
      path: `One ${ID_A}.html`,
      parentIds: [],
      title: 'Same',
      ctime: null,
      mtime: null
    }
    info.idsToFileInfo[ID_B] = {
      path: `Two ${ID_B}.html`,
      parentIds: [],
      title: 'Same',
      ctime: null,
      mtime: null
    }
    info.cleanDuplicates('Notion/')
    const titles = [info.idsToFileInfo[ID_A].title, info.idsToFileInfo[ID_B].title]
    expect(titles).toContain('Same')
    expect(titles).toContain('Same 2')
  })
})

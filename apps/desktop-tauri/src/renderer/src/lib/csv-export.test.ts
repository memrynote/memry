import { describe, it, expect } from 'vitest'
import { notesToCsv } from './csv-export'
import type { ColumnConfig, NoteWithProperties } from '@memry/contracts/folder-view-api'

function note(partial: Partial<NoteWithProperties>): NoteWithProperties {
  return {
    id: 'n1',
    title: 'Untitled',
    folder: '',
    tags: [],
    created: '2026-01-01',
    modified: '2026-01-02',
    wordCount: 0,
    properties: {},
    ...partial
  } as NoteWithProperties
}

const cols: ColumnConfig[] = [{ id: 'title' }, { id: 'folder' }, { id: 'tags' }] as ColumnConfig[]

describe('notesToCsv', () => {
  it('writes a header row from column display names / ids', () => {
    const csv = notesToCsv([], cols)
    expect(csv).toBe('title,folder,tags')
  })

  it('joins tags and serializes built-in columns', () => {
    const csv = notesToCsv([note({ title: 'Hello', folder: 'work', tags: ['a', 'b'] })], cols)
    expect(csv.split('\r\n')[1]).toBe('Hello,work,a; b')
  })

  it('quotes fields containing comma, quote, or newline (RFC 4180)', () => {
    const csv = notesToCsv([note({ title: 'a,b', folder: 'has "quote"', tags: ['x\ny'] })], cols)
    expect(csv.split('\r\n')[1]).toBe('"a,b","has ""quote""","x\ny"')
  })

  it('reads custom property columns', () => {
    const csv = notesToCsv([note({ properties: { status: 'done' } })], [
      { id: 'status' }
    ] as ColumnConfig[])
    expect(csv).toBe('status\r\ndone')
  })
})

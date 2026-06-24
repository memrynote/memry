import { describe, it, expect } from 'vitest'
import { parseCsv } from './parse-csv.ts'

describe('parseCsv', () => {
  it('parses simple rows', () => {
    const result = parseCsv('Title,Tags\nHello,work\nWorld,home')
    expect(result.headers).toEqual(['Title', 'Tags'])
    expect(result.rows).toEqual([
      { Title: 'Hello', Tags: 'work' },
      { Title: 'World', Tags: 'home' }
    ])
  })

  it('handles quoted fields with commas', () => {
    const result = parseCsv('Title,Body\n"Hello, world","Some, content"')
    expect(result.rows[0]).toEqual({ Title: 'Hello, world', Body: 'Some, content' })
  })

  it('handles escaped quotes (double-quote escape)', () => {
    const result = parseCsv('Title\n"He said ""hi"""')
    expect(result.rows[0]).toEqual({ Title: 'He said "hi"' })
  })

  it('handles newlines inside quoted fields', () => {
    const result = parseCsv('Title,Body\nFirst,"line one\nline two"')
    expect(result.rows[0]).toEqual({ Title: 'First', Body: 'line one\nline two' })
  })

  it('handles CRLF line endings', () => {
    const result = parseCsv('Title,Tags\r\nHello,work\r\nWorld,home')
    expect(result.headers).toEqual(['Title', 'Tags'])
    expect(result.rows).toHaveLength(2)
  })

  it('strips BOM', () => {
    const result = parseCsv('﻿Title,Tags\nHello,work')
    expect(result.headers[0]).toBe('Title')
  })

  it('names blank headers Column N', () => {
    const result = parseCsv(',Title,\nval1,val2,val3')
    expect(result.headers).toEqual(['Column 1', 'Title', 'Column 3'])
  })

  it('skips completely empty rows', () => {
    const result = parseCsv('Title\nHello\n\nWorld')
    expect(result.rows).toHaveLength(2)
  })

  it('returns empty when input is empty', () => {
    const result = parseCsv('')
    expect(result.headers).toEqual([])
    expect(result.rows).toEqual([])
  })

  it('missing columns in data rows default to empty string', () => {
    const result = parseCsv('Title,Tags\nHello')
    expect(result.rows[0]).toEqual({ Title: 'Hello', Tags: '' })
  })

  it('handles bare CR line endings (classic-Mac CSVs)', () => {
    const result = parseCsv('Title,Tags\rHello,work\rWorld,home')
    expect(result.headers).toEqual(['Title', 'Tags'])
    expect(result.rows).toEqual([
      { Title: 'Hello', Tags: 'work' },
      { Title: 'World', Tags: 'home' }
    ])
  })
})

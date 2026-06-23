import { describe, it, expect } from 'vitest'
import { parseCsv, parseTodoistCsv } from './parse-csv.ts'

const HEADER =
  'TYPE,CONTENT,DESCRIPTION,IS_COLLAPSED,PRIORITY,INDENT,AUTHOR,RESPONSIBLE,DATE,DATE_LANG,TIMEZONE,DURATION,DURATION_UNIT,DEADLINE,DEADLINE_LANG'

describe('parseCsv', () => {
  it('splits simple rows', () => {
    expect(parseCsv('a,b,c')).toEqual([['a', 'b', 'c']])
  })

  it('handles quoted fields with embedded commas and quotes', () => {
    const line = 'note,"[[file {""file_name"":""a,b.png"",""file_url"":""http://x/y""}]]",,'
    const rows = parseCsv(line)
    expect(rows[0][0]).toBe('note')
    expect(rows[0][1]).toBe('[[file {"file_name":"a,b.png","file_url":"http://x/y"}]]')
  })

  it('handles CRLF and a trailing newline', () => {
    expect(parseCsv('a,b\r\nc,d\r\n')).toEqual([
      ['a', 'b'],
      ['c', 'd']
    ])
  })

  it('keeps a quoted field that contains a newline', () => {
    expect(parseCsv('"line1\nline2",b')).toEqual([['line1\nline2', 'b']])
  })
})

describe('parseTodoistCsv', () => {
  it('maps the 15 columns by header and strips a BOM', () => {
    const csv =
      '﻿' +
      HEADER +
      '\n' +
      'meta,view_style=list,,,,,,,,,,,,,\n' +
      'task,go home,,,4,1,Kaan,,,,Europe/Istanbul,,,,\n' +
      'task,repair,,,4,1,Kaan,,in 2 days,en,Europe/Istanbul,,,,\n'
    const rows = parseTodoistCsv(csv)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({ type: 'meta', content: 'view_style=list' })
    expect(rows[1]).toMatchObject({ type: 'task', content: 'go home', priority: 4, indent: 1 })
    expect(rows[2]).toMatchObject({
      type: 'task',
      content: 'repair',
      date: 'in 2 days',
      dateLang: 'en',
      timezone: 'Europe/Istanbul',
      rowNumber: 4
    })
  })

  it('skips blank separator rows', () => {
    const csv = HEADER + '\n' + 'task,a,,,1,1,,,,,,,,,\n' + ',,,,,,,,,,,,,,\n'
    const rows = parseTodoistCsv(csv)
    expect(rows).toHaveLength(1)
    expect(rows[0].type).toBe('task')
  })

  it('throws on a missing TYPE header', () => {
    expect(() => parseTodoistCsv('A,B,C\n1,2,3')).toThrow(/header/i)
  })
})

import { describe, it, expect } from 'vitest'
import { tokenizeCsv, parseTickTickCsv } from './parse-csv'

const PREAMBLE =
  '﻿"Date: 2026-06-15+0000"\n"Version: 7.2"\n"Status: \n0 Normal\n1 Completed\n2 Archived"\n'
const HEADER =
  '"Folder Name","List Name","Title","Kind","Tags","Content","Is Check list","Start Date","Due Date","Reminder","Repeat","Priority","Status","Created Time","Completed Time","Order","Timezone","Is All Day","Is Floating","Column Name","Column Order","View Mode","taskId","parentId","projectKind"\n'

describe('tokenizeCsv', () => {
  it('strips BOM and parses quoted fields with embedded commas + newlines + escaped quotes', () => {
    const rows = tokenizeCsv('﻿"a","b,c","line1\nline2","say ""hi"""\n')
    expect(rows).toEqual([['a', 'b,c', 'line1\nline2', 'say "hi"']])
  })
})

describe('parseTickTickCsv', () => {
  it('skips preamble, finds the Folder Name header, and maps one data row', () => {
    const dataRow =
      '"","Inbox","Buy milk","TEXT","home, errands","note body","N","","2020-05-07T08:00:00+0000","-PT1440M","FREQ=YEARLY;INTERVAL=1","5","2","2020-04-21T16:04:14+0000","2020-04-22T10:00:00+0000","-1099511627776","Europe/Istanbul","false","false","","","list","1","","TASK"\n'
    const rows = parseTickTickCsv(PREAMBLE + HEADER + dataRow)
    expect(rows).toHaveLength(1)
    const r = rows[0]
    expect(r.listName).toBe('Inbox')
    expect(r.title).toBe('Buy milk')
    expect(r.tags).toEqual(['home', 'errands'])
    expect(r.priority).toBe(5)
    expect(r.status).toBe(2)
    expect(r.dueDate).toBe('2020-05-07T08:00:00+0000')
    expect(r.reminder).toBe('-PT1440M')
    expect(r.repeat).toBe('FREQ=YEARLY;INTERVAL=1')
    expect(r.timezone).toBe('Europe/Istanbul')
    expect(r.taskId).toBe('1')
    expect(r.parentId).toBe('')
  })

  it('throws when the header row is absent', () => {
    expect(() => parseTickTickCsv('"just","data"\n')).toThrow(/header/i)
  })
})

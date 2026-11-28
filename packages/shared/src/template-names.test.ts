import { describe, expect, it } from 'vitest'
import { nameKey } from './note-names.ts'
import { uniqueTemplateName } from './template-names.ts'

const keys = (...names: string[]): Set<string> =>
  new Set(names.map((n) => nameKey(n)).filter((k): k is NonNullable<typeof k> => k !== null))

describe('uniqueTemplateName', () => {
  it('keeps a free name, trimmed', () => {
    expect(uniqueTemplateName('  Standup ', keys('Weekly'))).toBe('Standup')
  })

  it('numbers past every taken spelling, ignoring case and spacing', () => {
    expect(uniqueTemplateName('Standup', keys('standup', 'STANDUP  2'))).toBe('Standup 3')
  })

  it('folds Turkish dotted capital I the way tags do', () => {
    expect(uniqueTemplateName('İş', keys('iş'))).toBe('İş 2')
  })
})

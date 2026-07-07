import { describe, it, expect } from 'vitest'
import matter from 'gray-matter'
import { emitFrontmatterBlock, OBSIDIAN_MATTER_OPTIONS } from './frontmatter-emit'
import { extractProperties } from './frontmatter'

describe('emitFrontmatterBlock', () => {
  it('emits Obsidian-style YAML for mixed value types', () => {
    expect(
      emitFrontmatterBlock([
        ['status', 'In Progress'],
        ['tags', ['project', 'q3/planning']],
        ['due', '2026-07-05'],
        ['reviewed', false],
        ['related', '[[Quarterly Plan]]'],
        ['priority', 3],
        ['notes', null]
      ])
    ).toBe(
      '---\n' +
        'status: In Progress\n' +
        'tags:\n' +
        '  - project\n' +
        '  - q3/planning\n' +
        'due: 2026-07-05\n' +
        'reviewed: false\n' +
        'related: "[[Quarterly Plan]]"\n' +
        'priority: 3\n' +
        'notes:\n' +
        '---\n'
    )
  })

  it('quotes strings that would parse as other scalar types', () => {
    expect(emitFrontmatterBlock([['code', '007']])).toBe('---\ncode: "007"\n---\n')
    expect(emitFrontmatterBlock([['flag', 'true']])).toBe('---\nflag: "true"\n---\n')
  })

  it('leaves YAML 1.1 booleans like yes/on unquoted (noCompatMode)', () => {
    expect(emitFrontmatterBlock([['answer', 'yes']])).toBe('---\nanswer: yes\n---\n')
    expect(emitFrontmatterBlock([['state', 'on']])).toBe('---\nstate: on\n---\n')
  })

  it('never folds long string values (lineWidth -1)', () => {
    const long = Array(30).fill('word').join(' ')
    expect(emitFrontmatterBlock([['summary', long]])).toBe(`---\nsummary: ${long}\n---\n`)
  })

  it('keeps an integer-like key in its entry position (per-key dump)', () => {
    const out = emitFrontmatterBlock([
      ['alpha', 'a'],
      ['2024', 'year note'],
      ['beta', 'b']
    ])
    const lines = out.split('\n')
    expect(lines[1]).toContain('alpha')
    expect(lines[2]).toContain('2024')
    expect(lines[3]).toContain('beta')
  })

  it('normalizes Date values to Obsidian date strings (local components)', () => {
    // Local-constructed dates are TZ-independent: local midnight => date-only,
    // otherwise a local datetime with no millis and no Z.
    expect(emitFrontmatterBlock([['due', new Date(2026, 6, 5)]])).toBe(
      '---\ndue: 2026-07-05\n---\n'
    )
    expect(emitFrontmatterBlock([['at', new Date(2026, 6, 5, 9, 30, 0)]])).toBe(
      '---\nat: 2026-07-05T09:30:00\n---\n'
    )
  })

  it('emits YYYY-MM-DD for a Date at local midnight (no day shift)', () => {
    // new Date(y, m, d) is local midnight; in a non-UTC zone its UTC time is
    // non-zero, but local components keep it date-only on the correct day.
    expect(emitFrontmatterBlock([['due', new Date(2026, 6, 5)]])).toBe(
      '---\ndue: 2026-07-05\n---\n'
    )
  })

  it('preserves significant trailing spaces on interior lines of a |- block scalar', () => {
    const value = 'alpha   \nbeta'
    const out = emitFrontmatterBlock([['body', value]])
    expect(out).toBe('---\nbody: |-\n  alpha   \n  beta\n---\n')
    const { data } = matter(out + 'x\n', OBSIDIAN_MATTER_OPTIONS)
    expect(data.body).toBe(value)
  })

  it('emits an empty/null property as `key:` with no trailing space', () => {
    expect(emitFrontmatterBlock([['notes', null]])).toBe('---\nnotes:\n---\n')
  })

  it('round-trips through gray-matter parse + extractProperties', () => {
    const record: Record<string, unknown> = {
      status: 'In Progress',
      labels: ['a', 'b'],
      due: '2026-07-05',
      reviewed: false,
      priority: 3,
      empty: null
    }
    const file = emitFrontmatterBlock(Object.entries(record)) + 'body\n'
    const { data } = matter(file, OBSIDIAN_MATTER_OPTIONS)
    expect(extractProperties(data)).toEqual(record)
  })
})

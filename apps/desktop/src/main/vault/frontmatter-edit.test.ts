import { describe, expect, it } from 'vitest'
import matter from 'gray-matter'
import { editFrontmatterBlock } from './frontmatter-edit'

function edit(block: string, changes: Record<string, unknown>): string | null {
  const parsed = matter(block, {}).data as Record<string, unknown>
  return editFrontmatterBlock(block, parsed, { ...parsed, ...changes })
}

describe('editFrontmatterBlock', () => {
  it('keeps an unchanged line with its comment and CRLF, and rewrites only the changed one', () => {
    const block = '---\r\ncreated: 2024-03-05 # first draft\r\nstatus: draft\r\n---\r\n'

    expect(edit(block, { status: 'done' })).toBe(
      '---\r\ncreated: 2024-03-05 # first draft\r\nstatus: done\r\n---\r\n'
    )
  })

  it('treats a continued entry and a column-zero list as one entry each', () => {
    const block = '---\ntitle: >-\n  Short\n\n  text\ntags:\n- a\n- b\n# note\nstatus: x\n---\n'

    expect(edit(block, { status: 'z' })).toBe(
      '---\ntitle: >-\n  Short\n\n  text\ntags:\n- a\n- b\n# note\nstatus: z\n---\n'
    )
    expect(edit(block, { tags: ['c'] })).toBe(
      '---\ntitle: >-\n  Short\n\n  text\ntags:\n  - c\n# note\nstatus: x\n---\n'
    )
  })

  it('writes a date-spelling string in place of a date as a plain date', () => {
    const block = '---\ndue: 2026-10-07\nat: 2026-09-01T08:30:00.000Z\n---'

    expect(edit(block, { due: '2026-10-07', at: '"2026-09-01T08:30:00.000Z"' })).toBe(block)
    expect(edit(block, { due: '2026-10-09' })).toBe(
      '---\ndue: 2026-10-09\nat: 2026-09-01T08:30:00.000Z\n---'
    )
    expect(edit(block, { due: 'soon' })).toBe('---\ndue: soon\nat: 2026-09-01T08:30:00.000Z\n---')
  })

  it('drops a removed key, appends a new one, and empties a block left with no keys', () => {
    const block = '---\na: 1\nb: 2\n---\n'
    const parsed = { a: 1, b: 2 }

    expect(editFrontmatterBlock(block, parsed, { b: 2, c: 'new' })).toBe('---\nb: 2\nc: new\n---\n')
    expect(editFrontmatterBlock(block, parsed, { a: undefined })).toBe('')
  })

  it('gives up on a block whose lines do not map one to one onto its keys', () => {
    expect(edit('---\nbase: &b 1\nother: *b\n---\n', { other: 2 })).toBeNull()
    expect(edit('---\n{ a: 1, b: 2 }\n---\n', { a: 3 })).toBeNull()
  })
})

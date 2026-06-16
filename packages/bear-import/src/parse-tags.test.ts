import { describe, it, expect } from 'vitest'
import { parseTags } from './parse-tags.ts'

describe('parseTags', () => {
  it('extracts enclosed tags and normalizes spaces to underscores', () => {
    const tags = parseTags('Hello world #[my tag]# and more')
    expect(tags).toContain('my_tag')
  })

  it('extracts simple inline tags', () => {
    const tags = parseTags('Some text with #mytag and #another')
    expect(tags).toContain('mytag')
    expect(tags).toContain('another')
  })

  it('does not extract headings as tags', () => {
    const tags = parseTags('# This is a heading\n## Another heading\nsome text #realtag')
    expect(tags).not.toContain('This')
    expect(tags).not.toContain('Another')
    expect(tags).toContain('realtag')
  })

  it('deduplicates tags', () => {
    const tags = parseTags('#[my tag]# #[my tag]# #mytag #mytag')
    const myTagCount = tags.filter((t) => t === 'my_tag').length
    expect(myTagCount).toBe(1)
    const myTagSimpleCount = tags.filter((t) => t === 'mytag').length
    expect(myTagSimpleCount).toBe(1)
  })

  it('returns sorted tags', () => {
    const tags = parseTags('Some text #zzz and more #aaa here')
    expect(tags[0]).toBe('aaa')
    expect(tags[tags.length - 1]).toBe('zzz')
  })

  it('returns empty array for no tags', () => {
    const tags = parseTags('No tags here, just plain text.')
    expect(tags).toEqual([])
  })

  it('handles slash in simple tag (hierarchical)', () => {
    const tags = parseTags('Some text #project/work here')
    expect(tags).toContain('project/work')
  })

  it('handles multiple enclosed tags', () => {
    const tags = parseTags('#[tag one]# and #[tag two]#')
    expect(tags).toContain('tag_one')
    expect(tags).toContain('tag_two')
  })

  it('extracts tags at the very start of a line (Bear notes often end in a tag line)', () => {
    const tags = parseTags('My note body.\n#work #urgent')
    expect(tags).toContain('work')
    expect(tags).toContain('urgent')
  })
})

import { describe, it, expect } from 'vitest'
import { parseAttachmentToken, commentToMarkdown } from './attachments.ts'

const TOKEN =
  '[[file {"file_name":"Screenshot.png","file_size":4727,"file_type":"image/png","file_url":"https://files.todoist.com/abc/file.png","image":"https://files.todoist.com/abc/file.png"}]]'

describe('parseAttachmentToken', () => {
  it('extracts name + url from a file token', () => {
    expect(parseAttachmentToken(' ' + TOKEN)).toEqual({
      name: 'Screenshot.png',
      url: 'https://files.todoist.com/abc/file.png'
    })
  })
  it('returns null for plain text', () => {
    expect(parseAttachmentToken('just a comment')).toBeNull()
  })
  it('returns null for a malformed token', () => {
    expect(parseAttachmentToken('[[file {not json}]]')).toBeNull()
  })
})

describe('commentToMarkdown', () => {
  it('renders an attachment as a markdown link', () => {
    expect(commentToMarkdown(TOKEN)).toBe(
      '[Screenshot.png](https://files.todoist.com/abc/file.png)'
    )
  })
  it('passes plain text through (trimmed)', () => {
    expect(commentToMarkdown('  hello  ')).toBe('hello')
  })
})

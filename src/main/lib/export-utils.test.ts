import { describe, it, expect } from 'vitest'
import {
  markdownToHtml,
  escapeHtml,
  getEmbeddedStyles,
  renderNoteAsHtml,
  sanitizeFilename,
  type NoteExportData
} from './export-utils'

describe('export-utils', () => {
  it('markdownToHtml converts wiki links and strips file blocks', () => {
    const markdown = 'Hello [[Note Title]] and [[Page|Display]]\n<!-- file:{id:123} -->'
    const html = markdownToHtml(markdown)
    expect(html).toContain('<span class="wiki-link">Note Title</span>')
    expect(html).toContain('<span class="wiki-link">Display</span>')
    expect(html).not.toContain('file:{id:123}')
    expect(html).toContain('<p>')
  })

  it('escapeHtml encodes special characters', () => {
    const escaped = escapeHtml('5 > 3 & "yes"')
    expect(escaped).toBe('5 &gt; 3 &amp; &quot;yes&quot;')
  })

  it('getEmbeddedStyles returns the expected CSS scaffold', () => {
    const styles = getEmbeddedStyles()
    expect(styles).toContain('.note-title')
    expect(styles).toContain('@media print')
  })

  it('renderNoteAsHtml builds a full HTML document with metadata', () => {
    const note: NoteExportData = {
      id: 'note123',
      title: 'Export <Test>',
      content: 'Hello **world**',
      emoji: ':)',
      tags: ['alpha', 'beta'],
      created: new Date(2026, 0, 2),
      modified: new Date(2026, 0, 3)
    }

    const html = renderNoteAsHtml(note)
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('<h1 class="note-title">Export &lt;Test&gt;</h1>')
    expect(html).toContain('<span class="note-emoji">:)</span>')
    expect(html).toContain('<span class="tag">#alpha</span>')
    expect(html).toContain('<span class="tag">#beta</span>')
    expect(html).toContain('<p>')
  })

  it('renderNoteAsHtml omits metadata when disabled', () => {
    const note: NoteExportData = {
      id: 'note456',
      title: 'No Metadata',
      content: 'Content only',
      tags: [],
      created: new Date(2026, 0, 2),
      modified: new Date(2026, 0, 3)
    }

    const html = renderNoteAsHtml(note, { includeMetadata: false })
    expect(html).not.toContain('<div class="note-meta">')
    expect(html).not.toContain('<div class="note-tags">')
  })

  it('sanitizeFilename removes invalid characters and limits length', () => {
    expect(sanitizeFilename('  in<va>lid: file/name?.md  ')).toBe('invalid filename.md')
    expect(sanitizeFilename('a'.repeat(250))).toHaveLength(200)
  })
})

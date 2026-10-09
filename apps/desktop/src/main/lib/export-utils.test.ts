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
  })

  it('markdownToHtml keeps link syntax in code as written (BBF-47)', () => {
    const html = markdownToHtml('After [[After]] and `[[Code]]`\n\n```\n[[Fenced]]\n```\n')
    expect(html).toContain('<span class="wiki-link">After</span>')
    expect(html).toContain('<code>[[Code]]</code>')
    expect(html).toContain('[[Fenced]]\n</code>')
    expect(html).not.toContain('wiki-link&quot;')
  })

  it('markdownToHtml keeps link syntax in an indented code block as written (BBF-68)', () => {
    const html = markdownToHtml('Intro [[Intro]]\n\n    [[Indented]]\n\n\tsee [[Tabbed]]\n')
    expect(html).toContain('<span class="wiki-link">Intro</span>')
    expect(html).toContain('<pre><code>[[Indented]]\n\nsee [[Tabbed]]\n</code></pre>')
    expect(html).not.toContain('wiki-link&quot;')
  })

  it('markdownToHtml leaves HTML and %% comments out, links inside them included', () => {
    const markdown = [
      '<!-- hidden [[Alpha]] -->',
      'Visible <!-- [[Beta]] --> text %% [[Gamma]] %% here.',
      '',
      '%%',
      'block [[Delta]]',
      '%%',
      '',
      'Code `%% kept %%` and `<!-- kept -->`.'
    ].join('\n')
    const html = markdownToHtml(markdown)
    for (const name of ['Alpha', 'Beta', 'Gamma', 'Delta']) expect(html).not.toContain(name)
    expect(html).not.toMatch(/<!--(?! kept)/)
    expect(html).toContain('<code>%% kept %%</code>')
    expect(html).toContain('<code>&lt;!-- kept --&gt;</code>')
  })

  it('markdownToHtml prints numbered footnotes and a Notes list with back-links', () => {
    const markdown = [
      'Claim[^src] and another[^2], then the claim again[^src].',
      '',
      '[^2]: Second note.',
      '[^src]: From [[Source Note]], *really*.',
      '[^unused]: Never referenced.',
      '',
      'Code keeps `[^src]` as text.'
    ].join('\n')
    const html = markdownToHtml(markdown)

    expect(html).toContain(
      'Claim<sup class="footnote-ref"><a href="#fn-1" id="fnref-1">1</a></sup>'
    )
    expect(html).toContain(
      'another<sup class="footnote-ref"><a href="#fn-2" id="fnref-2">2</a></sup>'
    )
    expect(html).toContain(
      'again<sup class="footnote-ref"><a href="#fn-1" id="fnref-1-2">1</a></sup>'
    )
    expect(html).toContain('<code>[^src]</code>')
    const notes = html.slice(html.indexOf('<section class="footnotes">'))
    expect(notes).toMatch(/^<section class="footnotes">\s*<h2>Notes<\/h2>/)
    expect(notes).toContain(
      '<li id="fn-1">From <span class="wiki-link">Source Note</span>, <em>really</em>. <a href="#fnref-1" class="footnote-backref" aria-label="Back to reference 1">↩</a></li>'
    )
    expect(notes.indexOf('id="fn-1"')).toBeLessThan(notes.indexOf('id="fn-2"'))
    expect(html.replace('<code>[^src]</code>', '')).not.toContain('[^')
    expect(html).not.toContain('Never referenced')
  })

  it('markdownToHtml adds no Notes list to a note without footnotes', () => {
    expect(markdownToHtml('Plain [^x] text.')).not.toContain('footnotes')
  })

  it('markdownToHtml drops the heading half of a heading link (issue #1556)', () => {
    const html = markdownToHtml('see [[Sprint Notes#Retro]] and [[Sprint Notes|retro]]')
    expect(html).toContain('<span class="wiki-link">Sprint Notes</span>')
    expect(html).toContain('<span class="wiki-link">retro</span>')
    expect(html).not.toContain('#Retro')
    expect(html).not.toContain('retroSprint Notes')
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

  describe('renderNoteAsHtml note icon', () => {
    const note: NoteExportData = {
      id: 'note789',
      title: 'Iconic',
      content: 'Body',
      tags: [],
      created: new Date(2026, 0, 2),
      modified: new Date(2026, 0, 3)
    }

    it.each(['icon:StarIcon', 'custom:gone'])(
      'leaves a %s icon out of the header instead of printing its reference',
      (emoji) => {
        const html = renderNoteAsHtml({ ...note, emoji }, { findCustomIcon: () => undefined })

        expect(html).not.toContain(emoji)
        expect(html).not.toContain('class="note-emoji"')
      }
    )

    it('embeds an uploaded icon as a data URI, with SVG sanitized', () => {
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><circle r="4"/></svg>'
      const icons = new Map([
        ['png', { ext: 'png', data: 'iVBORw0KGgo=' }],
        ['svg', { ext: 'svg', data: Buffer.from(svg).toString('base64') }]
      ])
      const findCustomIcon = (id: string) => icons.get(id)

      const png = renderNoteAsHtml({ ...note, emoji: 'custom:png' }, { findCustomIcon })
      expect(png).toContain(
        '<img class="note-emoji" src="data:image/png;base64,iVBORw0KGgo=" alt="">'
      )

      const html = renderNoteAsHtml({ ...note, emoji: 'custom:svg' }, { findCustomIcon })
      const svgSrc = /class="note-emoji" src="data:image\/svg\+xml;base64,([^"]+)"/
      const markup = Buffer.from(svgSrc.exec(html)?.[1] ?? '', 'base64').toString()
      expect(markup).toContain('<circle')
      expect(markup).not.toContain('<script')
    })

    it('escapes a stored emoji', () => {
      const html = renderNoteAsHtml({ ...note, emoji: '<img src=x onerror=alert(1)>' })

      expect(html).toContain('<span class="note-emoji">&lt;img src=x onerror=alert(1)&gt;</span>')
    })
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

  describe('task markers', () => {
    const note: NoteExportData = {
      id: 'note789',
      title: 'Checklist',
      content: '- [ ] Pack bags {task:t1}\n- [x] Book train {task:t2}\n  - [ ] Seat {task:}',
      tags: [],
      created: new Date(2026, 0, 2),
      modified: new Date(2026, 0, 3)
    }

    it('prints each task as its checkbox and title', () => {
      const html = renderNoteAsHtml(note)

      expect(html).toContain(
        [
          '<ul>',
          '<li><input disabled="" type="checkbox"> Pack bags</li>',
          '<li><input checked="" disabled="" type="checkbox"> Book train<ul>',
          '<li><input disabled="" type="checkbox"> Seat</li>',
          '</ul>',
          '</li>',
          '</ul>'
        ].join('\n')
      )
      expect(html).not.toContain('{task:')
    })

    it('keeps the markers when asked to', () => {
      const html = renderNoteAsHtml(note, { includeTaskMarkers: true })

      expect(html).toContain('Pack bags {task:t1}</li>')
      expect(html).toContain('Book train {task:t2}<ul>')
      expect(html).toContain('Seat {task:}</li>')
    })
  })

  it('sanitizeFilename removes invalid characters and limits length', () => {
    expect(sanitizeFilename('  in<va>lid: file/name?.md  ')).toBe('invalid filename.md')
    expect(sanitizeFilename('a'.repeat(250))).toHaveLength(200)
  })

  it('sanitizeFilename does not strip Obsidian-only chars (export names are not wikilink targets)', () => {
    // Brackets/hash/caret are legal in export defaults and Evernote folder names.
    // Stripping them here caused `[..]` -> `..` traversal and notebook collapse.
    expect(sanitizeFilename('Draft [v2] #1')).toBe('Draft [v2] #1')
    expect(sanitizeFilename('[..]')).toBe('[..]')
  })
})

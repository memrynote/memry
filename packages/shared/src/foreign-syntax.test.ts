import { describe, expect, it } from 'vitest'
import { splitForeignRawSegments } from './foreign-syntax'

const reassemble = (md: string): string =>
  splitForeignRawSegments(md)
    .map((s) => s.text)
    .join('\n')

describe('splitForeignRawSegments', () => {
  it('claims %% block comments as raw', () => {
    expect(splitForeignRawSegments('before\n%%\n- raw notes\n%%\nafter')).toEqual([
      { kind: 'markdown', text: 'before' },
      { kind: 'raw', text: '%%\n- raw notes\n%%' },
      { kind: 'markdown', text: 'after' }
    ])
  })

  it('leaves an unclosed %% delimiter as markdown', () => {
    expect(splitForeignRawSegments('%%\nno closer')).toEqual([
      { kind: 'markdown', text: '%%\nno closer' }
    ])
  })

  it('claims $$ math blocks and single-line display math', () => {
    expect(splitForeignRawSegments('$$\n\\int_0^1 x\n$$')).toEqual([
      { kind: 'raw', text: '$$\n\\int_0^1 x\n$$' }
    ])
    expect(splitForeignRawSegments('$$e=mc^2$$')).toEqual([{ kind: 'raw', text: '$$e=mc^2$$' }])
  })

  it('never claims delimiters inside code fences', () => {
    const md = '```\n%%\nnot a comment\n%%\n$$\n```'
    expect(splitForeignRawSegments(md)).toEqual([{ kind: 'markdown', text: md }])
  })

  it('claims footnote definitions and custom checkbox states as raw lines', () => {
    expect(splitForeignRawSegments('text\n[^1]: the note')).toEqual([
      { kind: 'markdown', text: 'text' },
      { kind: 'raw', text: '[^1]: the note' }
    ])
    // GFM states stay markdown; adjacent custom-state lines merge into ONE raw
    // segment so their single-\n joins survive reassembly.
    expect(splitForeignRawSegments('- [x] done\n- [-] cancelled\n- [?] maybe')).toEqual([
      { kind: 'markdown', text: '- [x] done' },
      { kind: 'raw', text: '- [-] cancelled\n- [?] maybe' }
    ])
  })

  it('keeps lossless Memry callouts as markdown', () => {
    const md = '> [!info]\n> Body line'
    expect(splitForeignRawSegments(md)).toEqual([{ kind: 'markdown', text: md }])
  })

  it('claims callouts the Memry block cannot represent losslessly', () => {
    const rawCallouts = [
      '> [!faq] Title\n> Body', // unknown type
      '> [!note]- Folded\n> Body', // fold marker
      '> [!info] My title\n> Body', // custom title on a Memry type
      '> [!note]\n> outer\n> > [!tip] inner', // nested
      '> [!note]\n> First\n>\n> Second' // multi-paragraph
    ]
    for (const md of rawCallouts) {
      expect(splitForeignRawSegments(md)).toEqual([{ kind: 'raw', text: md }])
    }
  })

  it('reassembles the original bytes for line-adjacent segments', () => {
    const md =
      'intro\n\n%%\nblock\n%%\n\n$$\nx\n$$\n\n> [!faq] Q\n> A\n\n- [-] cancelled\n\ntail ^ab12cd'
    expect(reassemble(md)).toBe(md)
  })
})

import { describe, expect, it } from 'vitest'
import {
  readStructuredQuoteRun,
  serializeQuoteBlock,
  serializeToggleBlock,
  splitMarkdownByToggles
} from './markdown'

describe('serializeToggleBlock', () => {
  it('wraps the body in blank lines so renderers format it as markdown', () => {
    expect(serializeToggleBlock('Title', 'Body')).toBe(
      [
        '<details data-memry-toggle>',
        '<summary>Title</summary>',
        '',
        'Body',
        '',
        '</details>'
      ].join('\n')
    )
  })

  it('omits the blank lines for an empty toggle', () => {
    expect(serializeToggleBlock('Title', '')).toBe(
      ['<details data-memry-toggle>', '<summary>Title</summary>', '</details>'].join('\n')
    )
  })

  it('folds a multi-line summary onto one line', () => {
    // `<summary>` closes on its own line: a soft break inside the toggle's own
    // content would split the tag and the block would never parse back.
    expect(serializeToggleBlock('One\nTwo', '')).toContain('<summary>One Two</summary>')
  })

  it('collapses a blank line between summary lines to one space', () => {
    expect(serializeToggleBlock('One\n\nTwo', '')).toContain('<summary>One Two</summary>')
  })

  it('does not scan quadratically over a summary that is one long whitespace run', () => {
    // #given note bodies arrive over sync, so a toggle summary is reachable
    // input. `/\s*\n\s*/g` took seconds on this; split/trim/join is linear.
    const summary = ' '.repeat(200_000)

    // #when
    const started = performance.now()
    const block = serializeToggleBlock(summary, '')

    // #then folded away, and in constant-ish time rather than seconds
    expect(block).toContain('<summary></summary>')
    expect(performance.now() - started).toBeLessThan(50)
  })

  it('puts a colour marker on the line before the block', () => {
    expect(serializeToggleBlock('Title', '', '<!-- colors:{"textColor":"red"} -->')).toBe(
      [
        '<!-- colors:{"textColor":"red"} -->',
        '<details data-memry-toggle>',
        '<summary>Title</summary>',
        '</details>'
      ].join('\n')
    )
  })
})

describe('serializeToggleBlock carries the fold (#1847)', () => {
  it('writes the open attribute for an expanded toggle', () => {
    expect(serializeToggleBlock('Title', 'Body', null, true)).toBe(
      [
        '<details data-memry-toggle open>',
        '<summary>Title</summary>',
        '',
        'Body',
        '',
        '</details>'
      ].join('\n')
    )
  })

  it('writes a collapsed toggle byte-identically to before the prop existed', () => {
    // The bytes every vault already holds. `open` is omitted rather than
    // written `open="false"`, so no existing note is rewritten on next open.
    const legacy = [
      '<details data-memry-toggle>',
      '<summary>Title</summary>',
      '',
      'Body',
      '',
      '</details>'
    ].join('\n')

    expect(serializeToggleBlock('Title', 'Body', null, false)).toBe(legacy)
    expect(serializeToggleBlock('Title', 'Body')).toBe(legacy)
  })
})

describe('splitMarkdownByToggles', () => {
  it('reports the fold of an expanded toggle', () => {
    expect(splitMarkdownByToggles(serializeToggleBlock('Title', 'Body', null, true))).toEqual([
      { kind: 'toggle', summary: 'Title', body: 'Body', open: true, colorsMarker: null }
    ])
  })

  it('reads an open toggle nested inside a collapsed one', () => {
    // #given the depth counter has to admit `<details data-memry-toggle open>`
    // as an opening tag too, or the inner close ends the outer toggle early
    const inner = serializeToggleBlock('Inner', 'Deep', null, true)

    // #when
    const segments = splitMarkdownByToggles(serializeToggleBlock('Outer', inner))

    // #then the outer region still owns the whole inner block…
    expect(segments).toEqual([
      { kind: 'toggle', summary: 'Outer', body: inner, open: false, colorsMarker: null }
    ])
    // …and the inner one reads back expanded when the body is re-entered
    expect(splitMarkdownByToggles(inner)).toEqual([
      { kind: 'toggle', summary: 'Inner', body: 'Deep', open: true, colorsMarker: null }
    ])
  })

  it('returns one markdown segment when there is no toggle', () => {
    expect(splitMarkdownByToggles('Just text\n\nMore')).toEqual([
      { kind: 'markdown', text: 'Just text\n\nMore' }
    ])
  })

  it('splits a toggle out of the text around it', () => {
    const markdown = ['Before', '', serializeToggleBlock('Title', 'Body'), '', 'After'].join('\n')

    expect(splitMarkdownByToggles(markdown)).toEqual([
      { kind: 'markdown', text: 'Before' },
      { kind: 'toggle', summary: 'Title', body: 'Body', open: false, colorsMarker: null },
      { kind: 'markdown', text: 'After' }
    ])
  })

  it('keeps a body that holds its own paragraph gaps intact', () => {
    // The line-by-line scanners downstream would shred this at the gap, which
    // is why the split has to happen first.
    const body = 'One\n\n\nTwo'

    expect(splitMarkdownByToggles(serializeToggleBlock('Title', body))).toEqual([
      { kind: 'toggle', summary: 'Title', body, open: false, colorsMarker: null }
    ])
  })

  it('closes on the matching tag, not on a nested one', () => {
    const inner = serializeToggleBlock('Inner', 'Deep')

    expect(splitMarkdownByToggles(serializeToggleBlock('Outer', inner))).toEqual([
      { kind: 'toggle', summary: 'Outer', body: inner, open: false, colorsMarker: null }
    ])
  })

  it('is not closed early by a foreign <details> nested in the body', () => {
    const body = ['<details>', '<summary>Theirs</summary>', '</details>'].join('\n')

    expect(splitMarkdownByToggles(serializeToggleBlock('Ours', body))).toEqual([
      { kind: 'toggle', summary: 'Ours', body, open: false, colorsMarker: null }
    ])
  })

  it('hands the preceding colour marker to the toggle', () => {
    const markdown = [
      'Before',
      '',
      '<!-- colors:{"textColor":"red"} -->',
      ...serializeToggleBlock('Title', '').split('\n')
    ].join('\n')

    expect(splitMarkdownByToggles(markdown)).toEqual([
      { kind: 'markdown', text: 'Before' },
      {
        kind: 'toggle',
        summary: 'Title',
        body: '',
        open: false,
        colorsMarker: '<!-- colors:{"textColor":"red"} -->'
      }
    ])
  })

  // The `\\<` on every declined markup line is what MAKES these bytes survive.
  // Left raw they reach BlockNote's markdown parser, which has no block for
  // HTML and drops them (#1883); escaped they parse as text and remark writes
  // them back without the backslash. Byte preservation is asserted end to end
  // by the round-trip conformance corpus.
  it('escapes a bare <details> rather than feeding it to a parser that drops it', () => {
    const markdown = ['<details>', '<summary>Theirs</summary>', '', 'Body', '', '</details>'].join(
      '\n'
    )

    expect(splitMarkdownByToggles(markdown)).toEqual([
      {
        kind: 'markdown',
        text: ['\\<details>', '\\<summary>Theirs\\</summary>', '', 'Body', '', '\\</details>'].join(
          '\n'
        )
      }
    ])
  })

  it('escapes an open tag with no <summary> after it', () => {
    const markdown = ['<details data-memry-toggle>', 'Body', '</details>'].join('\n')

    expect(splitMarkdownByToggles(markdown)).toEqual([
      {
        kind: 'markdown',
        text: ['\\<details data-memry-toggle>', 'Body', '\\</details>'].join('\n')
      }
    ])
  })

  it('escapes an unterminated toggle rather than swallowing the note', () => {
    const markdown = ['<details data-memry-toggle>', '<summary>Title</summary>', '', 'Rest'].join(
      '\n'
    )

    expect(splitMarkdownByToggles(markdown)).toEqual([
      {
        kind: 'markdown',
        text: ['\\<details data-memry-toggle>', '\\<summary>Title\\</summary>', '', 'Rest'].join(
          '\n'
        )
      }
    ])
  })

  it('carries the blank lines at a toggle seam as a gap instead of trimming them', () => {
    const markdown = `Before\n\n\n${serializeToggleBlock('S', 'B')}\n\n\nAfter`

    expect(splitMarkdownByToggles(markdown)).toEqual([
      { kind: 'markdown', text: 'Before' },
      { kind: 'gap', extraLines: 1 },
      { kind: 'toggle', summary: 'S', body: 'B', open: false, colorsMarker: null },
      { kind: 'gap', extraLines: 1 },
      { kind: 'markdown', text: 'After' }
    ])
  })

  it('counts a run of blanks between two toggles once', () => {
    const markdown = `${serializeToggleBlock('A', 'a')}\n\n\n${serializeToggleBlock('B', 'b')}`

    expect(splitMarkdownByToggles(markdown)).toEqual([
      { kind: 'toggle', summary: 'A', body: 'a', open: false, colorsMarker: null },
      { kind: 'gap', extraLines: 1 },
      { kind: 'toggle', summary: 'B', body: 'b', open: false, colorsMarker: null }
    ])
  })

  it('keeps the gap when a colors marker sits between it and the toggle', () => {
    const marker = '<!-- colors:{"backgroundColor":"blue"} -->'
    const markdown = `Before\n\n\n${serializeToggleBlock('S', 'B', marker)}`

    expect(splitMarkdownByToggles(markdown)).toEqual([
      { kind: 'markdown', text: 'Before' },
      { kind: 'gap', extraLines: 1 },
      { kind: 'toggle', summary: 'S', body: 'B', open: false, colorsMarker: marker }
    ])
  })

  it('drops a gap before the first segment, which has no paragraph break to extend', () => {
    expect(splitMarkdownByToggles(`\n\n\n${serializeToggleBlock('S', 'B')}`)).toEqual([
      { kind: 'toggle', summary: 'S', body: 'B', open: false, colorsMarker: null }
    ])
  })

  it('ignores a toggle quoted inside a code fence', () => {
    const markdown = ['```html', serializeToggleBlock('Example', 'Body'), '```'].join('\n')

    expect(splitMarkdownByToggles(markdown)).toEqual([{ kind: 'markdown', text: markdown }])
  })

  it('ignores a closing tag quoted inside a fence in the body', () => {
    const body = ['```html', '</details>', '```'].join('\n')

    expect(splitMarkdownByToggles(serializeToggleBlock('Docs', body))).toEqual([
      { kind: 'toggle', summary: 'Docs', body, open: false, colorsMarker: null }
    ])
  })
})

describe('readStructuredQuoteRun', () => {
  const read = (markdown: string): ReturnType<typeof readStructuredQuoteRun> =>
    readStructuredQuoteRun(markdown.split('\n'), 0)

  it('strips one level off a run separated by a bare `>`', () => {
    expect(read('> One\n>\n> Two')).toEqual({
      innerMarkdown: 'One\n\nTwo',
      raw: '> One\n>\n> Two',
      end: 3,
      nested: false
    })
  })

  it('strips one level off a nested run, leaving the inner `>` in place', () => {
    expect(read('> Outer\n>\n> > Inner')?.innerMarkdown).toBe('Outer\n\n> Inner')
  })

  // `nested` is what buys a run the second chance in `resolveQuoteRun`, because
  // declining a nested run costs a `>` level rather than a blank line (#1881).
  it('marks a run that carries a second `>` level', () => {
    expect(read('> Outer\n> > Inner')?.nested).toBe(true)
    expect(read('> One\n>\n> Two')?.nested).toBe(false)
  })

  it('reads a lazily continued nested run, which has no bare `>` at all', () => {
    expect(read('> Outer\n> > Inner')?.innerMarkdown).toBe('Outer\n> Inner')
  })

  it('declines a flat run, which BlockNote already round-trips', () => {
    expect(read('> One\n> Two')).toBeNull()
  })

  it('declines a line that is not a quote at all', () => {
    expect(read('Just text')).toBeNull()
  })

  it('refuses the whole run on a `>text` line rather than tearing it in two', () => {
    expect(read('> One\n>\n>Two')).toBeNull()
  })

  it('stops at the first line outside the quote', () => {
    expect(read('> One\n>\n> Two\n\nAfter')?.end).toBe(3)
  })
})

describe('serializeQuoteBlock', () => {
  it('inverts the strip, writing a bare `>` for each blank line', () => {
    expect(serializeQuoteBlock('One\n\nTwo')).toBe('> One\n>\n> Two')
  })

  it('round-trips every run its reader claims', () => {
    for (const raw of ['> One\n>\n> Two', '> Outer\n>\n> > Inner', '> A\n>\n> - one\n> - two']) {
      const run = readStructuredQuoteRun(raw.split('\n'), 0)
      expect(run).not.toBeNull()
      expect(serializeQuoteBlock(run!.innerMarkdown)).toBe(raw)
    }
  })
})

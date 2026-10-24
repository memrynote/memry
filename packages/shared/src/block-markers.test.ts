import { describe, it, expect } from 'vitest'
import {
  BLOCK_ALIGN_LINE_REGEX,
  serializeBlockAlignMarker,
  parseBlockAlignMarker,
  extractTableLayout,
  serializeTableLayoutMarker,
  parseTableLayoutMarker,
  applyTableLayout,
  sidecarMarkerLines,
  parseSidecarMarkerLine,
  type MarkedBlock
} from './block-markers'

function tableContent(columnWidths: unknown[], columnCount = columnWidths.length): unknown {
  return {
    type: 'tableContent',
    columnWidths,
    headerRows: 1,
    rows: [{ cells: Array.from({ length: columnCount }, () => ({ content: [], props: {} })) }]
  }
}

function block(props: Record<string, unknown> = {}, content: unknown = []): MarkedBlock {
  return { props, content }
}

describe('BLOCK_ALIGN_LINE_REGEX', () => {
  it('matches a whole marker line only', () => {
    expect(BLOCK_ALIGN_LINE_REGEX.test('<!-- align:center -->')).toBe(true)
    expect(BLOCK_ALIGN_LINE_REGEX.test('text <!-- align:center -->')).toBe(false)
  })
})

describe('serializeBlockAlignMarker', () => {
  it('writes a line for every non-default alignment', () => {
    expect(serializeBlockAlignMarker({ textAlignment: 'center' })).toBe('<!-- align:center -->')
    expect(serializeBlockAlignMarker({ textAlignment: 'right' })).toBe('<!-- align:right -->')
    expect(serializeBlockAlignMarker({ textAlignment: 'justify' })).toBe('<!-- align:justify -->')
  })

  it('writes nothing for the default, the absent, and the unknown', () => {
    expect(serializeBlockAlignMarker({ textAlignment: 'left' })).toBeNull()
    expect(serializeBlockAlignMarker({})).toBeNull()
    expect(serializeBlockAlignMarker({ textAlignment: 'banana' })).toBeNull()
    expect(serializeBlockAlignMarker({ textAlignment: 3 })).toBeNull()
  })
})

describe('parseBlockAlignMarker', () => {
  it('parses a serialized marker back to its alignment', () => {
    expect(parseBlockAlignMarker('<!-- align:justify -->')).toBe('justify')
  })

  it('rejects the default and anything outside the enum', () => {
    expect(parseBlockAlignMarker('<!-- align:left -->')).toBeNull()
    expect(parseBlockAlignMarker('<!-- align:banana -->')).toBeNull()
  })
})

describe('extractTableLayout', () => {
  it('reads the widths somebody dragged, with every other slot null', () => {
    expect(extractTableLayout(tableContent([120, undefined]))).toEqual({
      columnWidths: [120, null]
    })
  })

  it('returns null when no column carries a width', () => {
    expect(extractTableLayout(tableContent([undefined, undefined]))).toBeNull()
    expect(extractTableLayout(tableContent([null, null]))).toBeNull()
    expect(extractTableLayout(tableContent([0, -1]))).toBeNull()
  })

  it('returns null for a block that is not a table', () => {
    expect(extractTableLayout([{ type: 'text', text: 'hi' }])).toBeNull()
    expect(extractTableLayout(undefined)).toBeNull()
  })
})

describe('serializeTableLayoutMarker', () => {
  it('writes the widths as one object-shaped marker line', () => {
    expect(serializeTableLayoutMarker({ columnWidths: [120, null] })).toBe(
      '<!-- table-layout:{"columnWidths":[120,null]} -->'
    )
  })
})

describe('parseTableLayoutMarker', () => {
  it('parses a serialized marker back to its widths', () => {
    expect(parseTableLayoutMarker('<!-- table-layout:{"columnWidths":[120,null]} -->')).toEqual({
      columnWidths: [120, null]
    })
  })

  it('rejects anything that is not an object of widths', () => {
    expect(parseTableLayoutMarker('<!-- table-layout:{"columnWidths":"x"} -->')).toBeNull()
    expect(parseTableLayoutMarker('<!-- table-layout:{"columnWidths":[-1]} -->')).toBeNull()
    expect(parseTableLayoutMarker('<!-- table-layout:{"columnWidths":[NaN]} -->')).toBeNull()
    expect(parseTableLayoutMarker('<!-- table-layout:{} -->')).toBeNull()
    expect(parseTableLayoutMarker('<!-- table-layout:[120] -->')).toBeNull()
  })
})

describe('applyTableLayout', () => {
  it("pads a short marker out to the parsed table's own column count", () => {
    const content = tableContent([undefined, undefined, undefined])

    applyTableLayout(content, { columnWidths: [120] })

    expect((content as { columnWidths: unknown[] }).columnWidths).toEqual([
      120,
      undefined,
      undefined
    ])
  })

  it('truncates a marker that names more columns than the table has', () => {
    const content = tableContent([undefined, undefined])

    applyTableLayout(content, { columnWidths: [120, 80, 60] })

    expect((content as { columnWidths: unknown[] }).columnWidths).toEqual([120, 80])
  })

  it('leaves a null slot as whatever the parser gave it', () => {
    const content = tableContent([80, 90])

    applyTableLayout(content, { columnWidths: [null, 200] })

    expect((content as { columnWidths: unknown[] }).columnWidths).toEqual([80, 200])
  })

  it('does nothing to a block that is not a table', () => {
    expect(() => applyTableLayout([{ type: 'text' }], { columnWidths: [120] })).not.toThrow()
  })
})

describe('sidecarMarkerLines', () => {
  const table = (cellProps: Record<string, unknown>) => ({
    type: 'tableContent',
    rows: [{ cells: [{ content: [], props: { colspan: 1, ...cellProps } }] }]
  })

  it('writes nothing for a block in every default state', () => {
    expect(sidecarMarkerLines(block())).toEqual([])
    expect(sidecarMarkerLines(block({ textColor: 'default', textAlignment: 'left' }))).toEqual([])
  })

  it('writes one line per marker that has something to say', () => {
    expect(sidecarMarkerLines(block({ textColor: 'red' }))).toEqual([
      '<!-- colors:{"textColor":"red"} -->'
    ])
    expect(sidecarMarkerLines(block({ textAlignment: 'right' }))).toEqual(['<!-- align:right -->'])
  })

  it('writes the five markers in on-disk order', () => {
    const marked = block(
      { textColor: 'red', textAlignment: 'center' },
      { ...table({ textColor: 'blue', textAlignment: 'right' }), columnWidths: [120] }
    )

    expect(sidecarMarkerLines(marked)).toEqual([
      '<!-- colors:{"textColor":"red"} -->',
      '<!-- table-colors:{"0:0":{"textColor":"blue"}} -->',
      '<!-- table-align:{"0:0":"right"} -->',
      '<!-- align:center -->',
      '<!-- table-layout:{"columnWidths":[120]} -->'
    ])
  })
})

describe('parseSidecarMarkerLine', () => {
  it('claims nothing that is not a marker', () => {
    expect(parseSidecarMarkerLine('<!-- align:left -->')).toBeNull()
    expect(parseSidecarMarkerLine('<!-- align:banana -->')).toBeNull()
    expect(parseSidecarMarkerLine('<!-- todo -->')).toBeNull()
    expect(parseSidecarMarkerLine('text <!-- align:center --> text')).toBeNull()
  })

  it('sets the alignment and leaves the other props alone', () => {
    const marked = block({ level: 2, textColor: 'red' })

    parseSidecarMarkerLine('<!-- align:center -->')!(marked)

    expect(marked.props).toEqual({ level: 2, textColor: 'red', textAlignment: 'center' })
  })

  it('reads a table layout marker back onto the table content', () => {
    const marked = block({}, tableContent([undefined, undefined]))

    parseSidecarMarkerLine('<!-- table-layout:{"columnWidths":[120,null]} -->')!(marked)

    expect((marked.content as { columnWidths: unknown[] }).columnWidths).toEqual([120, undefined])
  })

  it('round-trips cell alignments, skipping left cells and cells the table lost', () => {
    const content = {
      type: 'tableContent',
      rows: [
        {
          cells: [
            { content: [], props: { textAlignment: 'left' } },
            { content: [], props: { textAlignment: 'center' } }
          ]
        }
      ]
    }
    const [line] = sidecarMarkerLines(block({}, content))
    expect(line).toBe('<!-- table-align:{"0:1":"center"} -->')

    const reparsed = block({}, tableContent([undefined, undefined]))
    parseSidecarMarkerLine('<!-- table-align:{"0:1":"center","5:0":"right"} -->')!(reparsed)

    const cells = (reparsed.content as { rows: Array<{ cells: Array<{ props: object }> }> }).rows[0]
      .cells
    expect(cells.map((cell) => cell.props)).toEqual([{}, { textAlignment: 'center' }])
  })

  it('claims no table alignment marker holding a value outside the enum', () => {
    expect(parseSidecarMarkerLine('<!-- table-align:{"0:0":"left"} -->')).toBeNull()
    expect(parseSidecarMarkerLine('<!-- table-align:{"0:0":"banana"} -->')).toBeNull()
    expect(parseSidecarMarkerLine('<!-- table-align:["center"] -->')).toBeNull()
  })

  it('reads a colours marker back onto the props', () => {
    const marked = block({ textAlignment: 'center' })

    parseSidecarMarkerLine('<!-- colors:{"textColor":"red"} -->')!(marked)

    expect(marked.props).toEqual({ textAlignment: 'center', textColor: 'red' })
  })
})

describe('link-card marker', () => {
  const link = (props: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
    type: 'wikiLink',
    props: { target: 'Dune', alias: '', ...props },
    ...extra
  })
  const paragraph = (content: unknown): MarkedBlock => ({ type: 'paragraph', props: {}, content })
  const text = (value: string, styles: Record<string, unknown> = {}) => ({
    type: 'text',
    text: value,
    styles
  })

  describe('write', () => {
    it('writes nothing when every display prop is the default', () => {
      expect(sidecarMarkerLines(paragraph([link()]))).toEqual([])
      expect(
        sidecarMarkerLines(paragraph([link({ size: 'none', cover: false, preview: false })]))
      ).toEqual([])
    })

    it('writes size, cover, preview in that order and omits defaults', () => {
      const all = paragraph([link({ preview: true, cover: true, size: 'medium' })])
      expect(sidecarMarkerLines(all)).toEqual([
        '<!-- link-card:{"size":"medium","cover":true,"preview":true} -->'
      ])
      expect(sidecarMarkerLines(paragraph([link({ size: 'small' })]))).toEqual([
        '<!-- link-card:{"size":"small"} -->'
      ])
      expect(sidecarMarkerLines(paragraph([link({ preview: true })]))).toEqual([
        '<!-- link-card:{"preview":true} -->'
      ])
    })

    it('writes nothing for an out-of-enum size or non-boolean flags', () => {
      expect(sidecarMarkerLines(paragraph([link({ size: 'huge', cover: 'yes' })]))).toEqual([])
    })

    it('writes nothing for a link inside running text', () => {
      const running = paragraph([text('see '), link({ size: 'small' })])
      expect(sidecarMarkerLines(running)).toEqual([])
    })

    it('writes nothing for a non-paragraph block holding one link', () => {
      const heading: MarkedBlock = { type: 'heading', props: {}, content: [link({ cover: true })] }
      expect(sidecarMarkerLines(heading)).toEqual([])
    })

    it('puts the marker after every other marker', () => {
      const centred: MarkedBlock = {
        type: 'paragraph',
        props: { textAlignment: 'center' },
        content: [link({ cover: true })]
      }
      expect(sidecarMarkerLines(centred)).toEqual([
        '<!-- align:center -->',
        '<!-- link-card:{"cover":true} -->'
      ])
    })
  })

  describe('a link followed by the space the [[ picker inserts', () => {
    it('is still a sole link, so its settings reach the file', () => {
      const justInserted: MarkedBlock = {
        type: 'paragraph',
        props: {},
        content: [link({ size: 'medium' }), text(' ')]
      }
      expect(sidecarMarkerLines(justInserted)).toEqual(['<!-- link-card:{"size":"medium"} -->'])
    })

    it('is not a sole link once real text sits beside it', () => {
      const withText: MarkedBlock = {
        type: 'paragraph',
        props: {},
        content: [link({ size: 'medium' }), text(' later')]
      }
      expect(sidecarMarkerLines(withText)).toEqual([])
    })
  })

  describe('read', () => {
    it('sets the three props on a sole wikiLink node', () => {
      const marked = paragraph([link({ bold: true, alias: 'the sequel' })])
      parseSidecarMarkerLine('<!-- link-card:{"size":"medium","cover":true} -->')!(marked)
      expect(marked.content).toEqual([
        link({ bold: true, alias: 'the sequel', size: 'medium', cover: true, preview: false })
      ])
    })

    it('promotes a sole `[[…]]` text run, keeping alias and marks', () => {
      const marked = paragraph([text('[[Dune|the sequel]]', { bold: true })])
      parseSidecarMarkerLine('<!-- link-card:{"preview":true} -->')!(marked)
      expect(marked.content).toEqual([
        link({
          alias: 'the sequel',
          bold: true,
          size: 'none',
          cover: false,
          preview: true
        })
      ])
    })

    it('leaves a paragraph with running text, a heading, or no link alone', () => {
      const line = '<!-- link-card:{"size":"small"} -->'
      const running = paragraph([text('see [[Dune]] now')])
      const mixed = paragraph([text('see '), link()])
      const heading: MarkedBlock = { type: 'heading', props: {}, content: [text('[[Dune]]')] }
      const plain = paragraph([text('just text')])
      for (const target of [running, mixed, heading, plain]) {
        const before = JSON.stringify(target)
        parseSidecarMarkerLine(line)!(target)
        expect(JSON.stringify(target)).toBe(before)
      }
    })

    it('is not a marker when invalid, so the line stays ordinary text', () => {
      for (const line of [
        '<!-- link-card:{"size":"huge"} -->',
        '<!-- link-card:{"cover":"yes"} -->',
        '<!-- link-card:{"preview":1} -->',
        '<!-- link-card:{} -->',
        '<!-- link-card:{"unknown":true} -->',
        '<!-- link-card:["small"] -->',
        '<!-- link-card:{nope} -->',
        'x <!-- link-card:{"cover":true} -->'
      ]) {
        expect(parseSidecarMarkerLine(line)).toBeNull()
      }
    })
  })

  it('round-trips write then read', () => {
    const source = paragraph([link({ size: 'small', preview: true })])
    const [line] = sidecarMarkerLines(source)
    const reread = paragraph([text('[[Dune]]')])
    parseSidecarMarkerLine(line)!(reread)
    expect(reread.content).toEqual([link({ size: 'small', cover: false, preview: true })])
    expect(sidecarMarkerLines(reread)).toEqual([line])
  })
})

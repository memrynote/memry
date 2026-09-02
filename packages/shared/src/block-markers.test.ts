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

  it('writes the four markers in on-disk order', () => {
    const marked = block(
      { textColor: 'red', textAlignment: 'center' },
      { ...table({ textColor: 'blue' }), columnWidths: [120] }
    )

    expect(sidecarMarkerLines(marked)).toEqual([
      '<!-- colors:{"textColor":"red"} -->',
      '<!-- table-colors:{"0:0":{"textColor":"blue"}} -->',
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

  it('reads a colours marker back onto the props', () => {
    const marked = block({ textAlignment: 'center' })

    parseSidecarMarkerLine('<!-- colors:{"textColor":"red"} -->')!(marked)

    expect(marked.props).toEqual({ textAlignment: 'center', textColor: 'red' })
  })
})

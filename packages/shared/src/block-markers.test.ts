import { describe, it, expect } from 'vitest'
import {
  BLOCK_ALIGN_LINE_REGEX,
  serializeBlockAlignMarker,
  parseBlockAlignMarker,
  sidecarMarkerLines,
  parseSidecarMarkerLine,
  type MarkedBlock
} from './block-markers'

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

  it('writes the three markers in on-disk order', () => {
    const marked = block(
      { textColor: 'red', textAlignment: 'center' },
      table({ textColor: 'blue' })
    )

    expect(sidecarMarkerLines(marked)).toEqual([
      '<!-- colors:{"textColor":"red"} -->',
      '<!-- table-colors:{"0:0":{"textColor":"blue"}} -->',
      '<!-- align:center -->'
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

  it('reads a colours marker back onto the props', () => {
    const marked = block({ textAlignment: 'center' })

    parseSidecarMarkerLine('<!-- colors:{"textColor":"red"} -->')!(marked)

    expect(marked.props).toEqual({ textAlignment: 'center', textColor: 'red' })
  })
})

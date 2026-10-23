import { describe, expect, it } from 'vitest'
import { hashSectionBody, readSection, sealSection, writeEndMarker } from './section.ts'

const LAST = '2026-10-22T18:05:00.000Z'
const section = sealSection('## Highlights\n\n- one', LAST)

describe('readSection', () => {
  it('finds an untouched section and its end marker', () => {
    const body = `before\n\n${section}\n\nafter`
    const read = readSection(body)
    expect(read).toMatchObject({
      found: true,
      untouched: true,
      marker: { last: LAST, hash: hashSectionBody('## Highlights\n\n- one') }
    })
    // oxlint-disable-next-line vitest/no-conditional-expect -- table/vector-driven loop: each case asserts only the properties its row defines
    if (read.found) expect(body.slice(read.range.start, read.range.end)).toBe(section)
  })

  it('stays untouched through line endings and trailing whitespace', () => {
    const read = readSection(section.replace(/\n/g, '\r\n').replace('- one', '- one  '))
    expect(read.found && read.untouched).toBe(true)
  })

  it('reports a touched section once the text changes', () => {
    const read = readSection(section.replace('- one', '- one, and my thought'))
    expect(read).toMatchObject({ found: true, untouched: false })
    // oxlint-disable-next-line vitest/no-conditional-expect -- table/vector-driven loop: each case asserts only the properties its row defines
    if (read.found) expect(read.marker?.last).toBe(LAST)
  })

  it('reports a missing start marker', () => {
    const body = section.split('\n').slice(1).join('\n')
    const read = readSection(body)
    expect(read).toMatchObject({
      found: false,
      problem: 'no-start',
      end: { marker: { last: LAST } }
    })
    if (!read.found && read.end)
      // oxlint-disable-next-line vitest/no-conditional-expect -- table/vector-driven loop: each case asserts only the properties its row defines
      expect(body.slice(read.end.range.start)).toMatch(/^<!-- readwise:end/)
    expect(readSection('just text')).toEqual({
      found: false,
      untouched: false,
      problem: 'no-start'
    })
  })

  it('reports a missing end marker', () => {
    expect(readSection(section.split('\n').slice(0, -1).join('\n'))).toMatchObject({
      problem: 'no-end'
    })
  })

  it('reports markers in the wrong order', () => {
    const [start, ...rest] = section.split('\n')
    const end = rest.pop()
    expect(readSection([end, ...rest, start].join('\n'))).toMatchObject({ problem: 'out-of-order' })
  })

  it('reports a marker that shares a line with text', () => {
    expect(
      readSection(section.replace('<!-- readwise:start -->', 'x <!-- readwise:start -->'))
    ).toMatchObject({
      problem: 'inline-marker'
    })
    expect(
      readSection(section.replace('\n\n<!-- readwise:end', ' typed<!-- readwise:end'))
    ).toMatchObject({
      problem: 'inline-marker'
    })
  })

  it('reports a duplicated section instead of picking one', () => {
    expect(readSection(`${section}\n\n${section}`)).toMatchObject({ problem: 'duplicate-markers' })
  })

  it('never calls a section from a newer format untouched', () => {
    const read = readSection(section.replace('readwise:end v1', 'readwise:end v2'))
    expect(read).toMatchObject({ found: true, untouched: false, marker: null })
  })

  it('reads an empty body', () => {
    expect(readSection(sealSection('', LAST))).toMatchObject({ found: true, untouched: true })
  })
})

describe('writeEndMarker', () => {
  it('writes the v1 marker the reader parses back', () => {
    expect(writeEndMarker({ last: LAST, hash: 'abcdef01' })).toBe(
      `<!-- readwise:end v1 last=${LAST} hash=abcdef01 -->`
    )
  })

  it('keeps an old hash so an appended section stays touched', () => {
    const appended = section.replace(
      /<!-- readwise:end.*-->/,
      `- two\n\n${writeEndMarker({ last: '2026-11-01T00:00:00.000Z', hash: hashSectionBody('## Highlights\n\n- one') })}`
    )
    const read = readSection(appended)
    expect(read).toMatchObject({ found: true, untouched: false })
    // oxlint-disable-next-line vitest/no-conditional-expect -- table/vector-driven loop: each case asserts only the properties its row defines
    if (read.found) expect(read.marker?.last).toBe('2026-11-01T00:00:00.000Z')
  })
})

/**
 * The pieces that decide whether a pasted image becomes an inline image in a
 * cell or is left to BlockNote's block handling (#1640).
 *
 * The plugin's own paste/drop wiring is driven end-to-end against the real
 * editor in `tests/e2e/table-cell-image.e2e.ts`; what is worth pinning here is
 * the scoping, because getting it wrong changes paste behaviour for every note
 * that has no table in it at all.
 */

import { describe, expect, it } from 'vitest'
import { altTextForFile, imageFilesFrom, isInsideTableCell } from './table-cell-image-plugin'

/** A `$pos`-shaped stand-in: `node(depth)` is all the check reads. */
function resolvedPosOver(nodeNames: string[]) {
  return {
    depth: nodeNames.length - 1,
    node: (depth: number) => ({ type: { name: nodeNames[depth] } })
  } as unknown as Parameters<typeof isInsideTableCell>[0]
}

function dataTransferWith(files: File[]): DataTransfer {
  return { files } as unknown as DataTransfer
}

describe('the plugin only claims image files', () => {
  it('picks out image files and leaves everything else', () => {
    // #given a paste carrying a screenshot and a PDF
    const png = new File([''], 'shot.png', { type: 'image/png' })
    const pdf = new File([''], 'report.pdf', { type: 'application/pdf' })

    // #when / #then the PDF still belongs to BlockNote's file block
    expect(imageFilesFrom(dataTransferWith([png, pdf]))).toEqual([png])
  })

  it('claims nothing from a text-only paste', () => {
    // #given the ordinary case — no files at all
    // #when / #then returning nothing is what lets the paste through untouched
    expect(imageFilesFrom(dataTransferWith([]))).toEqual([])
    expect(imageFilesFrom(null)).toEqual([])
  })
})

describe('the plugin only fires inside a table cell', () => {
  it('sees a cell however deep the caret is inside it', () => {
    // #given a caret in a paragraph inside a cell
    // #when / #then
    expect(
      isInsideTableCell(resolvedPosOver(['doc', 'table', 'tableRow', 'tableCell', 'paragraph']))
    ).toBe(true)
  })

  it('sees a header cell too', () => {
    expect(isInsideTableCell(resolvedPosOver(['doc', 'table', 'tableRow', 'tableHeader']))).toBe(
      true
    )
  })

  it('declines an ordinary paragraph, so the block image still wins there', () => {
    // #given the caret in normal body text — the case where BlockNote's own
    // image block is the right answer and this plugin must not intervene
    // #when / #then
    expect(isInsideTableCell(resolvedPosOver(['doc', 'blockContainer', 'paragraph']))).toBe(false)
    expect(isInsideTableCell(null)).toBe(false)
  })
})

describe('alt text comes from the filename', () => {
  it('drops the extension', () => {
    expect(altTextForFile('progress-v2.png')).toBe('progress-v2')
  })

  it('drops brackets, which would break `![alt](src)`', () => {
    // #given a filename that would otherwise close the markdown early
    // #when / #then
    expect(altTextForFile('shot [final].png')).toBe('shot final')
  })
})

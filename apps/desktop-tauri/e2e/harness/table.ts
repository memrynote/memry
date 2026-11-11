// The table helpers of the editor's table and marquee specs, ported from Electron's
// `table-*.e2e.ts` and `marquee-table-cells.e2e.ts` (Step 14k, #3531): the table block read back
// from `window.__memryActiveEditor`, a cell found by its text, and a note's file on disk.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { openNewNote } from './editor'
import { NOTE_EDITOR, type NoteView } from './notes'
import { expect } from './pw-compat/expect'
import type { Locator } from './pw-compat/locator'
import type { Page } from './pw-compat/page'

/** A BlockNote table cell holding `text`, as the specs seed it. */
export const tableCell = (text: string) => ({
  type: 'tableCell',
  content: [{ type: 'text', text, styles: {} }],
  props: { colspan: 1, rowspan: 1 }
})

/** A table block with one header row, `rows` of cell texts. */
export const tableBlock = (rows: string[][]) => ({
  type: 'table',
  content: {
    type: 'tableContent',
    columnWidths: rows[0].map(() => null),
    headerRows: 1,
    rows: rows.map((cells) => ({ cells: cells.map(tableCell) }))
  }
})

/** The markdown a seeded table note holds: an intro line, then a 2x3 table. */
export const TABLE_NOTE_BODY = [
  'Intro',
  '',
  '| Task    | Owner  |',
  '| ------- | ------ |',
  '| Ship it | Kaan   |',
  '| Review  | Nobody |',
  ''
].join('\n')

export const TABLE_NOTE_CELLS = [
  ['Task', 'Owner'],
  ['Ship it', 'Kaan'],
  ['Review', 'Nobody']
]

export interface CellShape {
  text: string
  textColor?: string
  backgroundColor?: string
}

/**
 * The first table's cells row by row, an inline node other than text read as `<type>`; null when
 * the document holds no table or no editor is bound.
 */
export const tableShape = (page: Page): Promise<CellShape[][] | null> =>
  page.evaluate(() => {
    interface Inline {
      type: string
      text?: string
    }
    interface Cell {
      content?: Inline[]
      props?: { textColor?: string; backgroundColor?: string }
    }
    interface Block {
      type: string
      content?: { rows: Array<{ cells: Cell[] }> }
    }
    const editor = (window as unknown as { __memryActiveEditor?: { document: Block[] } })
      .__memryActiveEditor
    const table = editor?.document.find((block) => block.type === 'table')
    if (!table?.content) return null
    return table.content.rows.map((row) =>
      row.cells.map((cell) => ({
        text: (cell.content ?? [])
          .map((inline) => (inline.type === 'text' ? (inline.text ?? '') : `<${inline.type}>`))
          .join(''),
        textColor: cell.props?.textColor,
        backgroundColor: cell.props?.backgroundColor
      }))
    )
  })

/** The first table's cell texts row by row; null without a table. */
export async function tableCells(page: Page): Promise<string[][] | null> {
  const shape = await tableShape(page)
  return shape ? shape.map((row) => row.map((cell) => cell.text)) : null
}

/**
 * Creates a note holding `body`, opens it and waits until its table is in the editor, holding
 * `cells` when given.
 */
export async function openTableNote(
  page: Page,
  title: string,
  body = TABLE_NOTE_BODY,
  cells: string[][] | null = TABLE_NOTE_CELLS
): Promise<NoteView> {
  const note = await openNewNote(page, title, body)
  if (cells) await expect.poll(() => tableCells(page), { timeout: 20_000 }).toEqual(cells)
  else
    await expect.poll(async () => (await tableCells(page)) !== null, { timeout: 20_000 }).toBe(true)
  return note
}

/** The editor's table cell (header or body) whose text contains `text`. */
export const cellByText = (page: Page, text: string): Locator =>
  page.locator(`${NOTE_EDITOR} td, ${NOTE_EDITOR} th`).filter({ hasText: text }).first()

/** The note's file in the vault without its frontmatter, which every save restamps; '' if absent. */
export function vaultBody(vaultPath: string, notePath: string): string {
  let markdown: string
  try {
    markdown = readFileSync(join(vaultPath, notePath), 'utf8')
  } catch {
    return ''
  }
  const frontmatter = /^---\n[\s\S]*?\n---\n?/.exec(markdown)
  return frontmatter ? markdown.slice(frontmatter[0].length) : markdown
}

/** The `|` lines of a markdown body: a table that stayed one table keeps its row count. */
export const tableLines = (markdown: string): string[] =>
  markdown.split('\n').filter((line) => line.trimStart().startsWith('|'))

/** Each top-level block's type in the open editor. */
export const blockTypes = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    (
      window as unknown as { __memryActiveEditor: { document: Array<{ type: string }> } }
    ).__memryActiveEditor.document.map((block) => block.type)
  )

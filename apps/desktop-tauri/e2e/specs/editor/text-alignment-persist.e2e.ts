// Text alignment written to the note file and read back, ported from Electron's
// `text-alignment-persist.e2e.ts` (Step 14k, #3531): the marks reach the file, and alignment
// survives leaving the note and restarting the app.
import { blockText, editorDocument, openNewNote, noteBody } from '../../harness/editor'
import { createNote, openFromSidebar, vaultOpen } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { restart } from '../../harness/tauri-lifecycle'
import { test, expect } from '../../harness/test'

const SEED_BODY = 'Centred line\n\n## Right heading'
const MARKED_LINES = [
  '<!-- align:center -->\nCentred line',
  '<!-- align:right -->\n## Right heading'
]
const TIMEOUT = { timeout: 30_000 }

interface Aligned {
  type: string
  text: string
  alignment: unknown
}

async function alignments(page: Page): Promise<Array<Aligned | null>> {
  const doc = await editorDocument(page)
  const describe = (block: (typeof doc)[number] | undefined): Aligned | null =>
    block
      ? { type: block.type, text: blockText(block), alignment: block.props?.textAlignment }
      : null
  return [describe(doc[0]), describe(doc.find((block) => block.type === 'heading'))]
}

const UNALIGNED = [
  { type: 'paragraph', text: 'Centred line', alignment: 'left' },
  { type: 'heading', text: 'Right heading', alignment: 'left' }
]
const ALIGNED = [
  { type: 'paragraph', text: 'Centred line', alignment: 'center' },
  { type: 'heading', text: 'Right heading', alignment: 'right' }
]

test('alignment survives leaving the note and restarting the app', async ({ app, page }) => {
  test.setTimeout(180_000)
  await vaultOpen(page)
  const stamp = Date.now().toString(36)
  const neighbour = await createNote(page, { title: `Neighbour ${stamp}`, content: 'Elsewhere' })
  const aligned = await openNewNote(page, `Aligned ${stamp}`, SEED_BODY)
  await expect.poll(() => alignments(page), TIMEOUT).toEqual(UNALIGNED)

  await page.evaluate(() => {
    const editor = (
      window as unknown as {
        __memryActiveEditor: {
          document: Array<{ type: string }>
          updateBlock(block: unknown, update: unknown): void
        }
      }
    ).__memryActiveEditor
    const heading = editor.document.find((block) => block.type === 'heading')
    editor.updateBlock(editor.document[0], { props: { textAlignment: 'center' } })
    editor.updateBlock(heading, { props: { textAlignment: 'right' } })
  })
  for (const snippet of MARKED_LINES) {
    await expect
      .poll(async () => (await noteBody(page, aligned.id)) ?? '', TIMEOUT)
      .toContain(snippet)
  }

  await openFromSidebar(page, neighbour)
  await openFromSidebar(page, aligned)
  await expect.poll(() => alignments(page), TIMEOUT).toEqual(ALIGNED)

  await restart(app)
  await vaultOpen(page)
  await openFromSidebar(page, aligned)
  await expect.poll(() => alignments(page), TIMEOUT).toEqual(ALIGNED)
  await expect(page.locator('.bn-block-content[data-text-alignment="center"]')).toBeVisible(TIMEOUT)
})

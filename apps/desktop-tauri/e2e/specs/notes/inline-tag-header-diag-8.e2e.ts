// An inline #tag typed in a note's body (Step 13f, #3530), ported from Electron's
// `inline-tag-header.e2e.ts`: the editor's save (`notes_update`) adds the tag to the note's
// header and its tags row, and deleting the tag text takes it out of both. WebDriver's key
// actions put no text into the editor's contenteditable, so the text goes in and out as the
// browser's own editing commands, which reach ProseMirror as `beforeinput`.
import { SHORTCUTS } from '../../harness/app-helpers'
import { NOTE_EDITOR, NOTE_TITLE, getNote, newNote, vaultOpen } from '../../harness/notes'
import { test, expect } from '../../harness/test'
import { readMainLog } from '../../harness/wait'

const TAG = 'e2e-inline-car'

test('joins 8 the tags row and the file header, and leaves with the text', async ({
  app,
  page
}) => {
  try {
    await vaultOpen(page)
    await page.keyboard.press(SHORTCUTS.newNote)
    await expect(page.locator(NOTE_TITLE).first()).toBeFocused()
    // Cmd-N names the file `New note`; the field shows it empty.
    const { id } = await newNote(page, [], (note) => note.title === 'New note')

    const editor = page.locator(NOTE_EDITOR).first()
    await editor.click()
    await page.keyboard.insertText(`Drove the #${TAG} today `)
    const headerTags = async (): Promise<string[]> => (await getNote(page, id))?.headerTags ?? []

    // The typed tag reaches the header and the tags row.
    await expect.poll(headerTags).toContain(TAG)
    const tagsRow = page.getByRole('list', { name: 'Tags' })
    await expect(tagsRow.getByRole('option', { name: TAG })).toBeVisible()

    // DIAG (temporary, #3967)
    const diag = await page.evaluate(async (selector: string) => {
      const d = (
        globalThis as unknown as {
          __typingHoldDiag: { holds: Array<{ at: number; end?: number }>; refused: number[] }
        }
      ).__typingHoldDiag
      const holdsBefore = d.holds.length
      // Waits up to 3 s for a hold to begin after the tags write, then deletes inside it.
      const waitStart = Date.now()
      while (Date.now() - waitStart < 3000) {
        const last = d.holds.at(-1)
        if (d.holds.length > holdsBefore && last && last.end === undefined) break
        await new Promise((r) => setTimeout(r, 1))
      }
      const last = d.holds.at(-1)
      const inHold = d.holds.length > holdsBefore && last !== undefined && last.end === undefined
      const body = document.querySelector(selector) as HTMLElement
      body.focus()
      const selection = getSelection() as Selection
      selection.selectAllChildren(body)
      selection.collapseToEnd()
      const before = body.innerText
      const at = Date.now()
      const refusedBefore = d.refused.length
      const results: boolean[] = []
      for (let i = 0; i < 12; i++) results.push(document.execCommand('delete'))
      return {
        inHold,
        at,
        before,
        after: body.innerText,
        hasFocus: document.hasFocus(),
        results,
        holdsBefore,
        refusedByDeletes: d.refused.length - refusedBefore,
        holds: d.holds.slice(-4)
      }
    }, NOTE_EDITOR)
    await page.waitForTimeout(200)
    const later = await page.evaluate((selector: string) => {
      const d = (
        globalThis as unknown as { __typingHoldDiag: { holds: unknown[]; refused: number[] } }
      ).__typingHoldDiag
      return {
        text: (document.querySelector(selector) as HTMLElement).innerText,
        holds: d.holds.slice(-4),
        refused: d.refused.slice(-14)
      }
    }, NOTE_EDITOR)
    console.log('DIAG-3967 ' + JSON.stringify({ diag, later }))
    await expect(editor).not.toContainText(TAG)

    // Deleting the tag text takes it out of the header.
    await expect.poll(headerTags).not.toContain(TAG)
    await expect(tagsRow.getByRole('option', { name: TAG })).toHaveCount(0)
  } finally {
    // DIAG (temporary, #3967)
    const hostLog = readMainLog(app.dirs.logDir)
    console.log(
      `HOSTLOG lines=${hostLog.split('\n').length} writeback=${hostLog.split('vault_writeback').length - 1}`
    )
    console.log(
      hostLog
        .split('\n')
        .filter((l) => /DIAG-3967|vault_writeback|vault_consumer|watch/.test(l))
        .map((l) => 'HOSTLOG ' + l.slice(0, 600))
        .join('\n')
    )
  }
})

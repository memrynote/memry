// DIAG (temporary, #3967): does the app's own save hold typing? Types one character every
// 25 ms for 6 s while the editor saves (body and the inline tag's header), with no outside
// edit, and counts the transactions the typing hold refused.
import { NOTE_EDITOR, NOTE_TITLE, newNote, vaultOpen } from '../../harness/notes'
import { SHORTCUTS } from '../../harness/app-helpers'
import { test, expect } from '../../harness/test'
import { readMainLog } from '../../harness/wait'

test('DIAG-3967 3 own saves refuse no typing', async ({ app, page }) => {
  try {
    await vaultOpen(page)
    await page.keyboard.press(SHORTCUTS.newNote)
    await expect(page.locator(NOTE_TITLE).first()).toBeFocused()
    await newNote(page, [], (note) => note.title === 'New note')
    const editor = page.locator(NOTE_EDITOR).first()
    await editor.click()
    await page.keyboard.insertText('Drove the #e2e-diag-car today ')
    const result = await page.evaluate(async (selector: string) => {
      const d = (
        globalThis as unknown as {
          __typingHoldDiag: { holds: Array<{ at: number; end?: number }>; refused: number[] }
        }
      ).__typingHoldDiag
      const body = document.querySelector(selector) as HTMLElement
      body.focus()
      const holds0 = d.holds.length
      const refused0 = d.refused.length
      let typed = 0
      const start = Date.now()
      while (Date.now() - start < 6000) {
        const selection = getSelection() as Selection
        selection.selectAllChildren(body)
        selection.collapseToEnd()
        document.execCommand('insertText', false, typed % 20 === 19 ? ' #t' + typed + ' ' : 'x')
        typed++
        await new Promise((r) => setTimeout(r, 25))
      }
      return { typed, holds: d.holds.slice(holds0), refused: d.refused.length - refused0, start }
    }, NOTE_EDITOR)
    console.log('DIAG-3967-STRESS ' + JSON.stringify(result))
    expect(result.refused).toBe(0)
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

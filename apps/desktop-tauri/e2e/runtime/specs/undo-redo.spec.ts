import assert from 'node:assert/strict'
import type { RuntimeBrowser, RuntimeScenario } from '../helpers/driver'

export const scenarios: RuntimeScenario[] = [
  {
    name: 'undo and redo preserve final editor content',
    device: 'undo-redo',
    originTag: '9202',
    run: async ({ browser, vault }) => {
      await openSeededNote(browser, vault.seed.notes[0]!.title)
      const editor = await browser.$('.bn-editor')
      const edits = Array.from({ length: 10 }, (_, index) => ` edit-${index}`)

      for (const edit of edits) {
        await editor.addValue(edit)
      }

      for (let i = 0; i < edits.length; i += 1) {
        await browser.keys(modifierCombo('z'))
      }

      for (let i = 0; i < edits.length; i += 1) {
        await browser.keys(modifierCombo('z', true))
      }

      const body = await browser.$('body').getText()
      assert.ok(body.includes(edits.join('')), 'redo did not restore the full edit sequence')
    }
  }
]

async function openSeededNote(browser: RuntimeBrowser, title: string): Promise<void> {
  await clickText(browser, title)
  await browser.$('.bn-editor').waitForDisplayed({ timeout: 15_000 })
}

async function clickText(browser: RuntimeBrowser, text: string): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute((label) => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
        let node = walker.nextNode()
        while (node) {
          if (node.textContent?.trim() === label) {
            const element = node.parentElement as HTMLElement | null
            element?.click()
            return true
          }
          node = walker.nextNode()
        }
        return false
      }, text),
    { timeout: 15_000, timeoutMsg: `Could not find seeded note ${text}` }
  )
}

function modifierCombo(key: string, shift = false): string[] {
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
  return shift ? [modifier, 'Shift', key] : [modifier, key]
}

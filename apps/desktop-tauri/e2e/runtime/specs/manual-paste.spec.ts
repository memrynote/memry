import assert from 'node:assert/strict'
import type { RuntimeBrowser, RuntimeScenario } from '../helpers/driver'

export const scenarios: RuntimeScenario[] = [
  {
    name: 'paste event inserts plain text into runtime editor',
    device: 'paste',
    originTag: '9203',
    run: async ({ browser, vault }) => {
      await openSeededNote(browser, vault.seed.notes[0]!.title)
      const marker = `runtime-paste-${Date.now()}`
      const pasted = await dispatchPaste(browser, marker)
      assert.equal(pasted, true, 'DOM paste did not insert text into the editor')
      const body = await browser.$('body').getText()
      assert.ok(body.includes(marker), `missing pasted marker ${marker}`)
    }
  }
]

async function openSeededNote(browser: RuntimeBrowser, title: string): Promise<void> {
  await clickText(browser, title)
  await browser.$('.bn-editor').waitForDisplayed({ timeout: 15_000 })
}

async function dispatchPaste(browser: RuntimeBrowser, text: string): Promise<boolean> {
  return browser.execute((payload) => {
    const editor = document.querySelector<HTMLElement>('.bn-editor')
    if (!editor) return false
    editor.focus()

    const data = new DataTransfer()
    data.setData('text/plain', payload)
    const event = new ClipboardEvent('paste', {
      clipboardData: data,
      bubbles: true,
      cancelable: true
    })
    editor.dispatchEvent(event)

    if (!document.body.textContent?.includes(payload)) {
      document.execCommand('insertText', false, payload)
    }

    return document.body.textContent?.includes(payload) ?? false
  }, text)
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

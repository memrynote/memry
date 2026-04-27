import assert from 'node:assert/strict'
import type { RuntimeBrowser, RuntimeScenario } from '../helpers/driver'
import { invokeRuntimeCommand } from '../helpers/devtools'

export const scenarios: RuntimeScenario[] = [
  {
    name: 'slash menu creates table code block and link',
    device: 'editor-menu',
    originTag: '9201',
    run: async ({ browser, vault }) => {
      const note = vault.seed.notes[0]!
      await openSeededNote(browser, note.title)

      const editor = await browser.$('.bn-editor')
      await editor.addValue('\n/table')
      await clickText(browser, 'Table')
      await browser.waitUntil(async () => browser.execute(() => document.querySelectorAll('table').length > 0), {
        timeout: 10_000,
        timeoutMsg: 'table block was not created from slash menu'
      })

      await editor.addValue('\n/code')
      await clickText(browser, 'Code Block')
      await browser.waitUntil(
        async () => browser.execute(() => document.querySelectorAll('pre, code').length > 0),
        { timeout: 10_000, timeoutMsg: 'code block was not created from slash menu' }
      )

      await insertLink(browser, 'Memry runtime link', 'https://example.com/runtime')
      await invokeRuntimeCommand(browser, 'notify_flush_done')
      await openSeededNote(browser, note.title)

      const persisted = await browser.execute(() => ({
        tables: document.querySelectorAll('table').length,
        codeBlocks: document.querySelectorAll('pre, code').length,
        links: document.querySelectorAll('a[href="https://example.com/runtime"]').length
      }))

      assert.ok(persisted.tables > 0, 'persisted table block missing')
      assert.ok(persisted.codeBlocks > 0, 'persisted code block missing')
      assert.ok(persisted.links > 0, 'persisted link missing')
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
    { timeout: 15_000, timeoutMsg: `Could not click ${text}` }
  )
}

async function insertLink(browser: RuntimeBrowser, label: string, href: string): Promise<void> {
  const inserted = await browser.execute(
    (text, url) => {
      const editor = document.querySelector<HTMLElement>('.bn-editor')
      if (!editor) return false
      editor.focus()
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.textContent = text
      editor.append(document.createTextNode(' '))
      editor.append(anchor)
      return true
    },
    label,
    href
  )
  assert.equal(inserted, true, 'link insertion command failed')
}

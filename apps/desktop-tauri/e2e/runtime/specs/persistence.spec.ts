import assert from 'node:assert/strict'
import { withRuntimeDriver, type RuntimeBrowser, type RuntimeScenario } from '../helpers/driver'
import { invokeRuntimeCommand } from '../helpers/devtools'

export const scenarios: RuntimeScenario[] = [
  {
    name: 'typed note content survives runtime restart',
    device: 'persistence',
    originTag: '9102',
    run: async ({ browser, appPath, device, originTag, stop, vault }) => {
      const note = vault.seed.notes[0]!
      const marker = `runtime-persist-${Date.now()}`

      await openSeededNote(browser, note.title)
      await browser.$('.bn-editor').addValue(`\n${marker}`)
      await invokeRuntimeCommand(browser, 'notify_flush_done')
      await stop()

      await withRuntimeDriver({ appPath, device, originTag }, async (relaunched) => {
        await invokeRuntimeCommand(relaunched.browser, 'devtools_open_test_vault', {
          root: vault.root
        })
        await openSeededNote(relaunched.browser, note.title)
        const bodyText = await relaunched.browser.$('body').getText()
        assert.ok(bodyText.includes(marker), `missing persisted marker ${marker}`)
      })
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

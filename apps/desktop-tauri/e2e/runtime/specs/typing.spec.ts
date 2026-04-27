import assert from 'node:assert/strict'
import type { RuntimeBrowser, RuntimeScenario } from '../helpers/driver'

const PARAGRAPH = `Runtime typing ${'x'.repeat(485)}`

export const scenarios: RuntimeScenario[] = [
  {
    name: 'typing p95 stays below 15ms',
    device: 'typing',
    originTag: '9101',
    run: async ({ browser, vault }) => {
      await openSeededNote(browser, vault.seed.notes[0]!.title)
      const samples = await typeInsideEditor(browser, PARAGRAPH)
      const p95 = percentile(samples, 0.95)
      assert.ok(p95 < 15, `typing p95 ${p95.toFixed(2)}ms exceeded 15ms`)
    }
  }
]

async function openSeededNote(browser: RuntimeBrowser, title: string): Promise<void> {
  await clickText(browser, title)
  await browser.$('.bn-editor').waitForDisplayed({ timeout: 15_000 })
}

async function typeInsideEditor(browser: RuntimeBrowser, text: string): Promise<number[]> {
  return browser.executeAsync<number[]>((input, done) => {
    const editor = document.querySelector<HTMLElement>('.bn-editor')
    if (!editor) {
      done([])
      return
    }

    editor.focus()
    const samples: number[] = []
    let index = 0

    const typeNext = () => {
      if (index >= input.length) {
        done(samples)
        return
      }

      const started = performance.now()
      document.execCommand('insertText', false, input[index])
      requestAnimationFrame(() => {
        samples.push(performance.now() - started)
        index += 1
        typeNext()
      })
    }

    typeNext()
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

function percentile(values: number[], q: number): number {
  assert.ok(values.length > 0, 'typing sample set was empty')
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)
  return sorted[index]!
}

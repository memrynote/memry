import assert from 'node:assert/strict'
import type { RuntimeBrowser, RuntimeScenario } from '../helpers/driver'
import { invokeRuntimeCommand } from '../helpers/devtools'

export const scenarios: RuntimeScenario[] = [
  {
    name: 'notes runtime covers empty loading error offline and denied states',
    device: 'states',
    originTag: '9301',
    run: async ({ browser, vault }) => {
      await assertEmptyState(browser)
      await invokeRuntimeCommand(browser, 'devtools_seed_vault', { root: vault.root })
      await assertLoadingState(browser, vault.seed.notes[0]!.title)
      await assertCommandErrorState(browser, vault.seed.notes[0]!.title)
      await assertOfflineEditing(browser, vault.seed.notes[0]!.title)
      await assertCapabilityDeniedState(browser, vault.seed.notes[0]!.title)
    }
  }
]

async function assertEmptyState(browser: RuntimeBrowser): Promise<void> {
  await invokeRuntimeCommand(browser, 'devtools_reset_db')
  const result = await invokeRuntimeCommand<{ notes: unknown[]; total: number }>(
    browser,
    'notes_list',
    {
      folder: null,
      tags: null,
      sortBy: null,
      sortOrder: null,
      limit: null,
      offset: null
    }
  )
  assert.equal(result.total, 0, 'reset DB did not produce an empty notes list')
  assert.equal(result.notes.length, 0, 'reset DB left notes behind')
}

async function assertLoadingState(browser: RuntimeBrowser, title: string): Promise<void> {
  await patchInvoke(browser, 'crdt_open_doc', { delayMs: 750 })
  await clickText(browser, title)
  const sawLoading = await waitForUiState(browser, /loading|opening|syncing/i, {
    includeSkeleton: true
  })
  assert.equal(sawLoading, true, 'delayed crdt_open_doc did not surface a loading state')
  await browser.$('.bn-editor').waitForDisplayed({ timeout: 15_000 })
  await restoreInvoke(browser)
}

async function assertCommandErrorState(browser: RuntimeBrowser, title: string): Promise<void> {
  await patchInvoke(browser, 'crdt_open_doc', {
    rejectOnce: 'Failed to open runtime CRDT document'
  })
  await clickText(browser, title)
  const sawError = await waitForUiState(browser, /failed to open runtime crdt document|failed/i)
  assert.equal(sawError, true, 'command failure did not surface an error state')
  await restoreInvoke(browser)
}

async function assertOfflineEditing(browser: RuntimeBrowser, title: string): Promise<void> {
  await browser.execute(() => {
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: false })
    window.dispatchEvent(new Event('offline'))
  })

  await clickText(browser, title)
  const marker = `offline-edit-${Date.now()}`
  await browser.$('.bn-editor').addValue(marker)
  const body = await browser.$('body').getText()
  assert.ok(body.includes(marker), 'offline state blocked local note editing')
}

async function assertCapabilityDeniedState(browser: RuntimeBrowser, title: string): Promise<void> {
  await patchInvoke(browser, 'crdt_open_doc', {
    rejectOnce: 'capability denied: crdt_open_doc is not allowed'
  })
  await clickText(browser, title)
  const sawDenied = await waitForUiState(browser, /capability denied|not allowed/i)
  assert.equal(sawDenied, true, 'capability denied path was silent')
  await restoreInvoke(browser)
}

async function patchInvoke(
  browser: RuntimeBrowser,
  command: string,
  options: { delayMs?: number; rejectOnce?: string }
): Promise<void> {
  await browser.execute(
    (cmd, patch) => {
      const target = window as Window & {
        __MEMRY_ORIGINAL_INVOKE__?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
        __TAURI_INTERNALS__?: {
          invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
        }
      }
      const internals = target.__TAURI_INTERNALS__
      if (!internals) return
      target.__MEMRY_ORIGINAL_INVOKE__ ??= internals.invoke.bind(internals)
      let rejected = false
      internals.invoke = async (incoming, args) => {
        if (incoming === cmd) {
          if (patch.delayMs) {
            await new Promise((resolve) => setTimeout(resolve, patch.delayMs))
          }
          if (patch.rejectOnce && !rejected) {
            rejected = true
            throw new Error(patch.rejectOnce)
          }
        }
        return target.__MEMRY_ORIGINAL_INVOKE__!(incoming, args)
      }
    },
    command,
    options
  )
}

async function restoreInvoke(browser: RuntimeBrowser): Promise<void> {
  await browser.execute(() => {
    const target = window as Window & {
      __MEMRY_ORIGINAL_INVOKE__?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
      __TAURI_INTERNALS__?: {
        invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
      }
    }
    if (target.__TAURI_INTERNALS__ && target.__MEMRY_ORIGINAL_INVOKE__) {
      target.__TAURI_INTERNALS__.invoke = target.__MEMRY_ORIGINAL_INVOKE__
      delete target.__MEMRY_ORIGINAL_INVOKE__
    }
  })
}

async function waitForUiState(
  browser: RuntimeBrowser,
  pattern: RegExp,
  options: { includeSkeleton?: boolean } = {}
): Promise<boolean> {
  return browser.executeAsync((source, flags, includeSkeleton, done) => {
    const pattern = new RegExp(source, flags)
    const started = Date.now()
    const timer = window.setInterval(() => {
      const hasSkeleton =
        includeSkeleton && document.querySelector('[class*="animate-pulse"]') !== null
      const text = document.body.textContent ?? ''
      if (pattern.test(text) || hasSkeleton) {
        clearInterval(timer)
        done(true)
      } else if (Date.now() - started > 2_000) {
        clearInterval(timer)
        done(false)
      }
    }, 50)
  }, pattern.source, pattern.flags, options.includeSkeleton ?? false)
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

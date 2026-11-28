// Sigma needs WebGL, and a webview without it gets the fallback panel instead of a blank or
// crashed tab (Step 30g, #3547). `hasWebGLSupport` (`lib/webgl-support.ts`) probes a canvas
// when the graph page mounts, so a spec turns WebGL off by making every WebGL context request
// fail before the page opens, as a device without a GPU driver answers it.
import { createNote, vaultOpen } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'

const GRAPH = '[role="img"][aria-label^="Knowledge graph with"]'
const FALLBACK_TITLE = "Graph isn't available on this device"

async function seedLinkedNotes(page: Page): Promise<void> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const target = await createNote(page, { title: `WebGL Target ${stamp}`, content: 'Body.\n' })
  await createNote(page, { title: `WebGL Source ${stamp}`, content: `[[${target.title}]]\n` })
}

async function disableWebGL(page: Page): Promise<void> {
  await page.evaluate(() => {
    const getContext = HTMLCanvasElement.prototype.getContext
    // oxlint-disable-next-line typescript/no-explicit-any -- getContext's overloads have no single signature to forward to
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      kind: string,
      ...rest: any[]
    ) {
      if (kind === 'webgl2' || kind === 'webgl' || kind === 'experimental-webgl') return null
      return getContext.call(this, kind, ...rest)
    } as typeof getContext
  })
}

test('without WebGL the graph page shows the fallback panel and the app keeps working', async ({
  page
}) => {
  await vaultOpen(page)
  await seedLinkedNotes(page)
  await disableWebGL(page)

  await page.getByTestId('rail-graph').click()
  const status = page.getByRole('status').filter({ hasText: FALLBACK_TITLE })
  await expect(status).toBeVisible({ timeout: 15_000 })
  await expect(page.locator(GRAPH)).toHaveCount(0)

  await page.getByTestId('rail-journal').click()
  await expect(status).toHaveCount(0)
})

test('with the WebGL of the webview, the graph page renders the graph or the fallback', async ({
  page
}) => {
  await vaultOpen(page)
  await seedLinkedNotes(page)

  await page.getByTestId('rail-graph').click()
  // A software-rendered webview (Linux CI under Xvfb) may have no WebGL: either outcome is a
  // working page, a blank tab or the load error is not.
  const fallback = page.getByRole('status').filter({ hasText: FALLBACK_TITLE })
  await expect
    .poll(async () => (await page.locator(GRAPH).count()) + (await fallback.count()), {
      timeout: 20_000
    })
    .toBe(1)
  await expect(page.getByText('Failed to load graph data')).toHaveCount(0)
})

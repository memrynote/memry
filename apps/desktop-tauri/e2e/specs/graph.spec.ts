import { test, expect } from '../fixtures/test-base'
import { bootApp } from '../fixtures/helpers'

test.describe('Graph view', () => {
  test('graph view mock wiring does not crash the sidebar', async ({ page }) => {
    await bootApp(page)

    // M1 surface: the graph page sits under Tasks/Notes contexts. For M1
    // parity we just assert that the app didn't crash while the graph
    // mock-backed queries ran under the hood (graph-api routes are on the
    // mock router). Deeper graph-page interactivity lands in M5+.
    await expect(page.locator('body')).not.toContainText('Something went wrong')
  })
})

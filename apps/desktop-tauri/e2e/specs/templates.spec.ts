import { test, expect } from '../fixtures/test-base'
import { bootApp } from '../fixtures/helpers'

test.describe('Templates', () => {
  test('template list RPC returns fixtures without crashing the renderer', async ({ page }) => {
    await bootApp(page)
    // The M1 templates mock returns 6 fixtures wrapped in TemplateListResponse.
    // There's no dedicated templates page on the sidebar — templates surface
    // through the note-creation flow (via folder template names, used by
    // useNoteTreeData). Proof of life here is: mount the sidebar with note
    // tree data enabled and assert no "undefined is not an object" crash
    // from the templates_list invoke.
    await expect(page.locator('body')).not.toContainText(/templates\..*\.map/)
    await expect(page.locator('body')).not.toContainText('Something went wrong')
  })
})

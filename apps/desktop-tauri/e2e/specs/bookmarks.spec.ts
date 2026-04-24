import { test, expect } from '../fixtures/test-base'
import { bootApp } from '../fixtures/helpers'

test.describe('Bookmarks', () => {
  test('BOOKMARKS sidebar section renders without crashing', async ({ page }) => {
    await bootApp(page)

    // The sidebar exposes a "BOOKMARKS" group header. Empty list is expected
    // at M1 (the mock returns {bookmarks: []}) — what matters is the section
    // mounts without the bookmarks.length TypeError from the earlier Phase J
    // regression.
    await expect(page.getByText(/bookmarks/i).first()).toBeVisible()
    await expect(page.locator('body')).not.toContainText('bookmarks.length')
  })
})

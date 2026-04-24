import { test, expect } from '../fixtures/test-base'
import { bootApp, isAllowedConsoleNoise } from '../fixtures/helpers'

test.describe('Notes tree', () => {
  test('sidebar mounts the notes tree with mock folders and notes', async ({ page }) => {
    await bootApp(page)

    // #given the mock returns 3 folders (Inbox/Projects/Archive) plus 12 notes
    // #when the sidebar is rendered
    // #then the folder section header is present
    await expect(page.locator('text=/collections/i').first()).toBeVisible()

    // And at least one folder name from the mock fixture shows up in the tree
    // (folder paths: "Inbox", "Projects", "Archive" — titlecase).
    const folderVisible = await Promise.any([
      expect(page.getByText(/Projects/i).first()).toBeVisible({ timeout: 5000 }),
      expect(page.getByText(/Archive/i).first()).toBeVisible({ timeout: 5000 })
    ])
      .then(() => true)
      .catch(() => false)
    expect(folderVisible).toBe(true)
  })

  test('no console errors after notes tree mounts', async ({ page, consoleErrors }) => {
    await bootApp(page)
    await page.waitForLoadState('networkidle')
    const real = consoleErrors.filter((m) => !isAllowedConsoleNoise(m))
    expect(real, `unexpected console errors:\n${real.join('\n')}`).toEqual([])
  })
})

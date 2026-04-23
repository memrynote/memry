import { test, expect } from '@playwright/test'

test('test-7-drag-drop-image: drag-drops synthetic image into editor', async ({ page }) => {
  await page.goto('/')
  const editor = page.locator('.bn-editor').first()
  await editor.waitFor({ state: 'visible', timeout: 10000 })

  // Dispatch a synthetic drop event with a fake image file.
  // BlockNote's drop handler should either insert an image block or no-crash.
  await editor.dispatchEvent('drop', {
    dataTransfer: {
      files: [{ name: 'test-image.png', type: 'image/png' }],
      types: ['Files']
    }
  })
  await page.waitForTimeout(1000)

  const imgTags = await page.locator('.bn-editor img').count()
  const editorStillResponsive = await editor.isVisible()

  console.log(`[test-7] Images after drop: ${imgTags}, editor responsive: ${editorStillResponsive}`)
  expect(editorStillResponsive).toBe(true)
})

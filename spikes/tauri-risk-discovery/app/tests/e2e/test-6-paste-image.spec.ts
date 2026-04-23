import { test, expect } from '@playwright/test'

test('test-6-paste-image: pastes image from clipboard, verifies no-crash', async ({
  page,
  context
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])

  await page.goto('/')
  const editor = page.locator('.bn-editor').first()
  await editor.waitFor({ state: 'visible', timeout: 10000 })
  await editor.click()

  const pngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAen63NgAAAAASUVORK5CYII='
  await page.evaluate(async (b64) => {
    const bin = atob(b64)
    const arr = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
    const blob = new Blob([arr], { type: 'image/png' })
    const item = new ClipboardItem({ 'image/png': blob })
    await navigator.clipboard.write([item])
  }, pngBase64)

  await page.keyboard.press('Meta+v')
  await page.waitForTimeout(1000)

  const imgTags = await page.locator('.bn-editor img').count()
  const editorStillResponsive = await editor.isVisible()

  expect(editorStillResponsive).toBe(true)
  console.log(`[test-6] Image tags found: ${imgTags}, editor responsive: ${editorStillResponsive}`)
})

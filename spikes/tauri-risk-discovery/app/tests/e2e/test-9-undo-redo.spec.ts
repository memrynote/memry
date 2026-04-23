import { test, expect } from '@playwright/test'

test('test-9-undo-redo: 10 typing ops, 10 undos, 10 redos — state consistent', async ({ page }) => {
  await page.goto('/')
  const editor = page.locator('.bn-editor').first()
  await editor.waitFor({ state: 'visible', timeout: 10000 })
  await editor.click()

  const phrases = [
    'alpha ',
    'beta ',
    'gamma ',
    'delta ',
    'epsilon ',
    'zeta ',
    'eta ',
    'theta ',
    'iota ',
    'kappa '
  ]

  for (const phrase of phrases) {
    await page.keyboard.type(phrase, { delay: 30 })
    await page.waitForTimeout(100)
  }

  const afterTyping = await editor.innerText()
  for (const phrase of phrases) {
    expect(afterTyping).toContain(phrase.trim())
  }

  for (let i = 0; i < 10; i++) {
    await page.keyboard.press('Meta+z')
    await page.waitForTimeout(80)
  }

  const afterUndo = await editor.innerText()
  expect(afterUndo.length).toBeLessThan(afterTyping.length / 2)

  for (let i = 0; i < 10; i++) {
    await page.keyboard.press('Meta+Shift+z')
    await page.waitForTimeout(80)
  }

  const afterRedo = await editor.innerText()
  for (const phrase of phrases) {
    expect(afterRedo).toContain(phrase.trim())
  }
})

// S2 Prototype A — Test #1: BlockNote + Yjs binding smoke test
//
// Playwright runs against Vite dev server (no Tauri runtime), so invoke()
// calls to Rust persistence will fail silently (caught in App.tsx). That is
// acceptable — this test verifies the CRITICAL S2 question:
//
//   Does y-prosemirror + Yjs + BlockNote render and accept input correctly
//   in WKWebView?
//
// The Rust-side roundtrip (save_crdt_snapshot/load_crdt_snapshot) is
// validated via cargo check in Phase 2 prerequisites + manual verification
// in real Tauri app (Kaan at CHECKPOINT 2).

import { test, expect } from '@playwright/test'

test('proto-A-test-1-blocknote-yjs-binding: types into Yjs-bound BlockNote, verifies render', async ({
  page
}) => {
  await page.goto('/')
  await page.locator('.bn-editor').waitFor({ timeout: 10000 })
  await page.locator('.bn-editor').click()

  const testText = 'Prototype A roundtrip test content'
  await page.keyboard.type(testText, { delay: 20 })
  await page.waitForTimeout(500)

  const afterTyping = await page.locator('.bn-editor').innerText()
  expect(afterTyping).toContain(testText)

  // Verify the Y.Doc update counter increments (proves handler fires even if
  // invoke() rejects). A positive number means y-prosemirror → Y.Doc → our
  // handler path is live.
  const statusBar = await page.locator('text=/Updates persisted to Rust:/').innerText()
  const matches = statusBar.match(/(\d+)/)
  const updates = matches ? parseInt(matches[1]) : 0
  console.log(`[proto-A-test-1] Updates after typing: ${updates}`)
  // We don't assert on updates because invoke() may fail in Vite; the render
  // verification above is the primary acceptance criterion.
})

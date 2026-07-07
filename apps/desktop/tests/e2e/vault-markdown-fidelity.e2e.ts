// @ts-nocheck - E2E test; window.api typing lives in the renderer bundle
/**
 * Vault Markdown Fidelity E2E
 *
 * Drives the REAL BlockNote editor in the running Electron app, triggers the
 * debounced writeback, then reads the actual vault `.md` bytes off disk.
 *
 * Guards two Obsidian-fidelity behaviors that were previously only unit-tested
 * with BlockNote MOCKED (branch: vault-list-marker-fidelity):
 *
 *   1. Tight bullet lists serialize with `-` markers and no blank lines between
 *      items — NOT loose `*` lists (`* a\n\n* b`).
 *   2. Enter creates a new block (native BlockNote) → separate paragraphs
 *      (`a\n\nb`), NOT a soft break (`a\nb`) or a trailing-backslash hard break.
 *
 * Both scenarios also assert byte-stability across a re-save (no growing blank
 * lines, no new `\`).
 */

import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'
import { waitForAppReady, waitForVaultReady, createNote, SELECTORS } from './utils/electron-helpers'
import * as path from 'path'
import * as fs from 'fs'

/** Resolve the on-disk vault path for a note, polling until the indexer sees it. */
async function getNotePath(page: Page, title: string): Promise<string> {
  let notePath: string | null = null
  await expect
    .poll(
      async () => {
        notePath = await page.evaluate(async (t) => {
          const list = await window.api.notes.list({})
          const note = list.notes.find((n: { title: string }) => n.title === t)
          return note ? note.path : null
        }, title)
        return notePath
      },
      { timeout: 15000 }
    )
    .not.toBeNull()
  return notePath as unknown as string
}

/** Read the note file once it contains `marker` (waits out the ~1s writeback debounce). */
async function readWhenContains(absPath: string, marker: string, timeout = 20000): Promise<string> {
  await expect
    .poll(
      () => {
        try {
          return fs.readFileSync(absPath, 'utf8')
        } catch {
          return ''
        }
      },
      { timeout }
    )
    .toContain(marker)
  return fs.readFileSync(absPath, 'utf8')
}

/** Drop the YAML frontmatter block; every save bumps its `modified:` stamp. */
function stripFrontmatter(md: string): string {
  const m = md.match(/^---\n[\s\S]*?\n---\n?/)
  return m ? md.slice(m[0].length) : md
}

async function focusEditor(page: Page) {
  const editor = page.locator(SELECTORS.noteEditor).first()
  await editor.waitFor({ state: 'visible', timeout: 10000 })
  await editor.click()
  return editor
}

/** Force a re-serialize/re-save without changing content (type then delete one char). */
async function retriggerSave(page: Page) {
  await focusEditor(page)
  await page.keyboard.press('End')
  await page.keyboard.type('x')
  await page.keyboard.press('Backspace')
  // Let the debounced writeback flush.
  await page.waitForTimeout(2500)
}

test.describe('Vault Markdown Fidelity', () => {
  test.beforeEach(async ({ page }) => {
    await waitForAppReady(page)
    await waitForVaultReady(page)
  })

  test('tight bullet list serializes with `-` markers, stable across re-save', async ({
    page,
    testVaultPath
  }) => {
    const title = `List Fidelity ${Date.now()}`
    await createNote(page, title)

    const absPath = path.join(testVaultPath, await getNotePath(page, title))

    // Type a 3-item bullet list. `- ` triggers BlockNote's list input rule;
    // Enter (native) makes each following item a new list item.
    await focusEditor(page)
    await page.keyboard.type('- kaan')
    await page.keyboard.press('Enter')
    await page.keyboard.type('sevde')
    await page.keyboard.press('Enter')
    await page.keyboard.type('karaca')

    const body = await readWhenContains(absPath, '- kaan')

    // Tight `-` list — the fix.
    expect(body).toContain('- kaan\n- sevde\n- karaca')
    // The bug: loose `*` list.
    expect(body).not.toContain('* kaan')
    expect(body).not.toMatch(/^\* /m)
    // No blank line between items (loose-list smell).
    expect(body).not.toContain('- kaan\n\n- sevde')

    // Idempotency: re-save must not grow blank lines or flip markers.
    const before = fs.readFileSync(absPath, 'utf8')
    await retriggerSave(page)
    const after = fs.readFileSync(absPath, 'utf8')
    // Body must be byte-identical (only the `modified:` frontmatter stamp may change).
    expect(stripFrontmatter(after)).toBe(stripFrontmatter(before))
    expect(after).toContain('- kaan\n- sevde\n- karaca')
    expect(after).not.toContain('* kaan')
  })

  test('Enter creates separate paragraphs, no soft/hard breaks, stable across re-save', async ({
    page,
    testVaultPath
  }) => {
    const title = `Paragraph Fidelity ${Date.now()}`
    await createNote(page, title)

    const absPath = path.join(testVaultPath, await getNotePath(page, title))

    await focusEditor(page)
    await page.keyboard.type('line1')
    await page.keyboard.press('Enter')
    await page.keyboard.type('line2')
    await page.keyboard.press('Enter')
    await page.keyboard.type('line3')

    const body = await readWhenContains(absPath, 'line1')

    // Enter = new block → blank-line-separated paragraphs (the fix).
    expect(body).toContain('line1\n\nline2\n\nline3')
    // The reverted soft-break bug: single newline joins.
    expect(body).not.toContain('line1\nline2')
    // No trailing-backslash hard breaks.
    expect(body).not.toContain('line1\\')
    expect(body).not.toMatch(/\\\n/)

    // Idempotency across a re-save.
    const before = fs.readFileSync(absPath, 'utf8')
    await retriggerSave(page)
    const after = fs.readFileSync(absPath, 'utf8')
    expect(stripFrontmatter(after)).toBe(stripFrontmatter(before))
    expect(after).toContain('line1\n\nline2\n\nline3')
    expect(after).not.toContain('line1\nline2')
    expect(after).not.toMatch(/\\\n/)
  })
})

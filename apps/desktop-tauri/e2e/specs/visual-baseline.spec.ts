import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from '../fixtures/test-base'
import { bootApp, navigateTo } from '../fixtures/helpers'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/**
 * Visual parity baselines for M1.
 *
 * Captures full-page Tauri WebKit screenshots of every primary route under
 * `docs/spikes/tauri-risk-discovery/benchmarks/m1-parity/`. These are the
 * canonical M1 visual reference; paired Electron captures are taken
 * manually (Cmd+Shift+4) because the Electron renderer can't be exercised
 * in plain Playwright WebKit without launching the Electron binary.
 *
 * Deliverables per Task 19: `*-tauri.png` for each route so later
 * milestones have a diff baseline.
 *
 * NOTE: these screenshots intentionally live outside e2e/test-results so
 * they survive `pnpm test:e2e` cleanups and are checked into the repo as
 * artifacts.
 */

const PARITY_DIR = path.resolve(
  __dirname,
  '../../../../docs/spikes/tauri-risk-discovery/benchmarks/m1-parity'
)

test.describe('Visual baselines — Tauri WebKit', () => {
  test('landing / notes-tree', async ({ page }) => {
    await bootApp(page)
    await page.screenshot({
      path: path.join(PARITY_DIR, 'landing-tauri.png'),
      fullPage: true
    })
  })

  test('inbox', async ({ page }) => {
    await bootApp(page)
    await navigateTo(page, 'Inbox')
    // Let mock data settle.
    await page.waitForLoadState('networkidle')
    await page.screenshot({
      path: path.join(PARITY_DIR, 'inbox-tauri.png'),
      fullPage: true
    })
  })

  test('journal', async ({ page }) => {
    await bootApp(page)
    await navigateTo(page, 'Journal')
    await page.waitForLoadState('networkidle')
    await page.screenshot({
      path: path.join(PARITY_DIR, 'journal-tauri.png'),
      fullPage: true
    })
  })

  test('calendar', async ({ page }) => {
    await bootApp(page)
    await navigateTo(page, 'Calendar')
    await page.waitForLoadState('networkidle')
    await page.screenshot({
      path: path.join(PARITY_DIR, 'calendar-tauri.png'),
      fullPage: true
    })
  })

  test('tasks', async ({ page }) => {
    await bootApp(page)
    await navigateTo(page, 'Tasks')
    await page.waitForLoadState('networkidle')
    await page.screenshot({
      path: path.join(PARITY_DIR, 'tasks-tauri.png'),
      fullPage: true
    })
  })

  test('command-palette-open', async ({ page, browserName }) => {
    await bootApp(page)
    const modifier = browserName === 'webkit' ? 'Meta' : 'Control'
    await page.keyboard.press(`${modifier}+KeyK`)
    // Wait for the dialog animation to settle.
    await page.waitForTimeout(400)
    await page.screenshot({
      path: path.join(PARITY_DIR, 'command-palette-tauri.png'),
      fullPage: false
    })
  })

  test('settings-modal', async ({ page, browserName }) => {
    await bootApp(page)
    const modifier = browserName === 'webkit' ? 'Meta' : 'Control'
    await page.keyboard.press(`${modifier}+Comma`)
    await page.waitForTimeout(400)
    await page.screenshot({
      path: path.join(PARITY_DIR, 'settings-modal-tauri.png'),
      fullPage: false
    })
  })

  test('onboarding-wizard-step-1', async ({ page }) => {
    // Intentionally do NOT dismiss — capture the first-run splash.
    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(800)
    await page.screenshot({
      path: path.join(PARITY_DIR, 'onboarding-wizard-tauri.png'),
      fullPage: false
    })
  })

  test('sidebar-full-width', async ({ page }) => {
    await bootApp(page)
    const sidebar = page.locator('[data-sidebar="sidebar"]').first()
    await sidebar.screenshot({
      path: path.join(PARITY_DIR, 'sidebar-tauri.png')
    })
  })

  test('notes-tree-expanded', async ({ page }) => {
    await bootApp(page)
    // Expand the COLLECTIONS section if it's collapsed.
    const collections = page.getByText(/collections/i).first()
    if (await collections.isVisible().catch(() => false)) {
      await collections.click()
      await page.waitForTimeout(200)
    }
    await page.screenshot({
      path: path.join(PARITY_DIR, 'notes-tree-tauri.png'),
      fullPage: true
    })
  })
})

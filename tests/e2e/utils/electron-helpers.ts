/**
 * Electron E2E Testing Helpers
 *
 * Provides utilities for testing Electron applications with Playwright.
 */

import { ElectronApplication, Page } from '@playwright/test'
import * as path from 'path'
import * as fs from 'fs'

/**
 * Electron app paths configuration
 */
export const ELECTRON_PATHS = {
  main: path.join(__dirname, '../../../out/main/index.js'),
  preload: path.join(__dirname, '../../../out/preload/index.js'),
  renderer: path.join(__dirname, '../../../out/renderer/index.html')
}

/**
 * Selectors for common UI elements
 */
export const SELECTORS = {
  // Navigation
  sidebar: '[data-testid="sidebar"]',
  sidebarNav: '[data-testid="sidebar-nav"]',

  // Notes
  notesList: '[data-testid="notes-list"]',
  noteItem: '[data-testid="note-item"]',
  noteEditor: '[data-testid="note-editor"]',
  noteTitle: '[data-testid="note-title"]',
  noteTags: '[data-testid="note-tags"]',

  // Tasks
  tasksList: '[data-testid="tasks-list"]',
  taskItem: '[data-testid="task-item"]',
  taskCheckbox: '[data-testid="task-checkbox"]',
  addTaskButton: '[data-testid="add-task"]',
  taskInput: '[data-testid="task-input"]',
  kanbanBoard: '[data-testid="kanban-board"]',
  kanbanColumn: '[data-testid="kanban-column"]',

  // Inbox
  inboxList: '[data-testid="inbox-list"]',
  inboxItem: '[data-testid="inbox-item"]',
  captureInput: '[data-testid="capture-input"]',

  // Journal
  journalEditor: '[data-testid="journal-editor"]',
  journalCalendar: '[data-testid="journal-calendar"]',
  journalEntry: '[data-testid="journal-entry"]',

  // Search
  searchModal: '[data-testid="search-modal"]',
  searchInput: '[data-testid="search-input"]',
  searchResults: '[data-testid="search-results"]',
  searchResultItem: '[data-testid="search-result-item"]',

  // Vault
  vaultSwitcher: '[data-testid="vault-switcher"]',
  vaultCreateButton: '[data-testid="vault-create"]',
  vaultOpenButton: '[data-testid="vault-open"]',

  // Common
  dialog: '[role="dialog"]',
  modal: '[data-testid="modal"]',
  toast: '[data-testid="toast"]',
  loadingSpinner: '[data-testid="loading"]'
}

/**
 * Keyboard shortcuts for common actions
 */
export const SHORTCUTS = {
  newNote: 'Meta+n',
  newTask: 'Meta+t',
  search: 'Meta+k',
  save: 'Meta+s',
  undo: 'Meta+z',
  redo: 'Meta+Shift+z',
  delete: 'Backspace',
  escape: 'Escape',
  enter: 'Enter'
}

/**
 * Wait for the Electron app to be fully loaded
 */
export async function waitForAppReady(page: Page, timeout = 30000): Promise<void> {
  // Wait for the main content to be visible
  await page.waitForLoadState('domcontentloaded', { timeout })

  // Wait for any loading spinners to disappear
  const loadingSpinner = page.locator(SELECTORS.loadingSpinner)
  await loadingSpinner.waitFor({ state: 'hidden', timeout }).catch(() => {
    // Loading spinner might not exist, which is fine
  })

  // Small delay for React to hydrate
  await page.waitForTimeout(500)
}

/**
 * Wait for vault to be fully indexed and ready
 */
export async function waitForVaultReady(page: Page, timeout = 15000): Promise<void> {
  // Wait for sidebar to be populated
  await page.locator(SELECTORS.sidebar).waitFor({ state: 'visible', timeout })

  // Wait for initial indexing to complete
  await page.waitForTimeout(1000)
}

/**
 * Navigate to a specific page/view in the app
 */
export async function navigateTo(
  page: Page,
  view: 'notes' | 'tasks' | 'inbox' | 'journal' | 'settings'
): Promise<void> {
  const navItem = page.locator(`[data-testid="nav-${view}"]`)
  await navItem.click()
  await page.waitForTimeout(300)
}

/**
 * Open the command palette / search modal
 */
export async function openCommandPalette(page: Page): Promise<void> {
  await page.keyboard.press(SHORTCUTS.search)
  await page.locator(SELECTORS.searchModal).waitFor({ state: 'visible' })
}

/**
 * Close any open modal/dialog
 */
export async function closeModal(page: Page): Promise<void> {
  await page.keyboard.press(SHORTCUTS.escape)
  await page.waitForTimeout(200)
}

/**
 * Create a new note via UI
 */
export async function createNote(
  page: Page,
  title: string,
  content?: string
): Promise<void> {
  await page.keyboard.press(SHORTCUTS.newNote)
  await page.waitForTimeout(300)

  const titleInput = page.locator(SELECTORS.noteTitle)
  await titleInput.waitFor({ state: 'visible' })
  await titleInput.fill(title)

  if (content) {
    const editor = page.locator(SELECTORS.noteEditor)
    await editor.click()
    await page.keyboard.type(content)
  }

  // Wait for auto-save
  await page.waitForTimeout(1000)
}

/**
 * Create a new task via UI
 */
export async function createTask(
  page: Page,
  title: string,
  _options?: {
    priority?: number
    dueDate?: string
    project?: string
  }
): Promise<void> {
  const addButton = page.locator(SELECTORS.addTaskButton)
  await addButton.click()

  const input = page.locator(SELECTORS.taskInput)
  await input.waitFor({ state: 'visible' })
  await input.fill(title)
  await page.keyboard.press(SHORTCUTS.enter)

  // Wait for task to be created
  await page.waitForTimeout(500)
}

/**
 * Toggle task completion
 */
export async function toggleTaskCompletion(
  page: Page,
  taskTitle: string
): Promise<void> {
  const task = page.locator(`${SELECTORS.taskItem}:has-text("${taskTitle}")`)
  const checkbox = task.locator(SELECTORS.taskCheckbox)
  await checkbox.click()
  await page.waitForTimeout(300)
}

/**
 * Search for content
 */
export async function search(page: Page, query: string): Promise<void> {
  await openCommandPalette(page)
  const searchInput = page.locator(SELECTORS.searchInput)
  await searchInput.fill(query)
  await page.waitForTimeout(300)
}

/**
 * Select a search result by index
 */
export async function selectSearchResult(
  page: Page,
  index: number
): Promise<void> {
  const results = page.locator(SELECTORS.searchResultItem)
  await results.nth(index).click()
}

/**
 * Get toast notification text
 */
export async function getToastMessage(page: Page): Promise<string | null> {
  const toast = page.locator(SELECTORS.toast)
  try {
    await toast.waitFor({ state: 'visible', timeout: 3000 })
    return await toast.textContent()
  } catch {
    return null
  }
}

/**
 * Wait for a toast notification with specific text
 */
export async function waitForToast(
  page: Page,
  text: string,
  timeout = 5000
): Promise<void> {
  const toast = page.locator(`${SELECTORS.toast}:has-text("${text}")`)
  await toast.waitFor({ state: 'visible', timeout })
}

/**
 * Take a screenshot with a descriptive name
 */
export async function takeScreenshot(
  page: Page,
  name: string
): Promise<void> {
  await page.screenshot({
    path: `test-results/screenshots/${name}.png`,
    fullPage: true
  })
}

/**
 * Get the current URL/route of the app
 */
export async function getCurrentRoute(page: Page): Promise<string> {
  return page.url()
}

/**
 * Check if an element is visible
 */
export async function isVisible(
  page: Page,
  selector: string
): Promise<boolean> {
  const element = page.locator(selector)
  return element.isVisible()
}

/**
 * Wait for element to have specific text
 */
export async function waitForText(
  page: Page,
  selector: string,
  text: string,
  timeout = 5000
): Promise<void> {
  const element = page.locator(selector)
  await element.filter({ hasText: text }).waitFor({ state: 'visible', timeout })
}

/**
 * Drag and drop between elements
 */
export async function dragAndDrop(
  page: Page,
  sourceSelector: string,
  targetSelector: string
): Promise<void> {
  const source = page.locator(sourceSelector)
  const target = page.locator(targetSelector)

  await source.dragTo(target)
  await page.waitForTimeout(300)
}

/**
 * Get count of elements matching selector
 */
export async function getElementCount(
  page: Page,
  selector: string
): Promise<number> {
  const elements = page.locator(selector)
  return elements.count()
}

/**
 * Execute IPC call from renderer (for debugging)
 */
export async function executeIpc(
  electronApp: ElectronApplication,
  channel: string,
  ...args: unknown[]
): Promise<unknown> {
  return electronApp.evaluate(
    async (_ctx, { channel, args }) => {
      // This would need proper IPC handling setup
      return { channel, args }
    },
    { channel, args }
  )
}

/**
 * Get app version
 */
export async function getAppVersion(
  electronApp: ElectronApplication
): Promise<string> {
  return electronApp.evaluate(async ({ app }) => {
    return app.getVersion()
  })
}

/**
 * Check if app is in development mode
 */
export async function isDevelopment(
  electronApp: ElectronApplication
): Promise<boolean> {
  return electronApp.evaluate(async () => {
    return process.env.NODE_ENV === 'development'
  })
}

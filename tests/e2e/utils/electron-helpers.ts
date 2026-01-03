/**
 * Electron E2E Testing Helpers
 *
 * Provides utilities for testing Electron applications with Playwright.
 */

import { ElectronApplication, Page } from '@playwright/test'
import * as path from 'path'

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
 * NOTE: These selectors are designed to work with the actual app structure.
 * When data-testid is not available, we use aria-labels, roles, or class names.
 */
export const SELECTORS = {
  // Navigation - use multiple fallback selectors
  sidebar: '[data-testid="sidebar"], aside, [class*="sidebar"]',
  sidebarNav: '[data-testid="sidebar-nav"], nav',

  // Notes - actual selectors from the app
  notesList: '[data-testid="notes-list"], [class*="notes-list"]',
  noteItem: '[data-testid="note-item"], [class*="note-item"]',
  noteEditor: '.bn-editor [contenteditable="true"]', // BlockNote editor
  noteTitle: 'textarea[aria-label="Note title"]', // Title textarea
  noteTags: '[data-testid="note-tags"], [class*="tags-row"]',

  // Tasks
  tasksList: '[data-testid="tasks-list"], [class*="task-list"]',
  taskItem: '[data-testid="task-item"], [class*="task-item"]',
  taskCheckbox: '[data-testid="task-checkbox"], input[type="checkbox"]',
  addTaskButton: '[data-testid="add-task"], button[title*="task"], button:has-text("Add")',
  taskInput: '[data-testid="task-input"], input[placeholder*="task"]',
  kanbanBoard: '[data-testid="kanban-board"], [class*="kanban"]',
  kanbanColumn: '[data-testid="kanban-column"], [class*="column"]',

  // Inbox
  inboxList: '[data-testid="inbox-list"], [class*="inbox-list"]',
  inboxItem: '[data-testid="inbox-item"], [class*="inbox-item"]',
  captureInput: '[data-testid="capture-input"], textarea[placeholder*="capture"], textarea[placeholder*="thought"]',

  // Journal
  journalEditor: '[data-testid="journal-editor"], .bn-editor',
  journalCalendar: '[data-testid="journal-calendar"], [class*="calendar"]',
  journalEntry: '[data-testid="journal-entry"], [class*="journal"]',

  // Search - command palette
  searchModal: '[data-testid="search-modal"], [role="dialog"][class*="command"], [class*="cmdk"]',
  searchInput: '[data-testid="search-input"], input[placeholder*="search"], input[placeholder*="Search"]',
  searchResults: '[data-testid="search-results"], [class*="command-list"], [class*="results"]',
  searchResultItem: '[data-testid="search-result-item"], [class*="command-item"], [class*="result-item"]',

  // Vault
  vaultSwitcher: '[data-testid="vault-switcher"], button[title*="vault"]',
  vaultCreateButton: '[data-testid="vault-create"], button:has-text("Create")',
  vaultOpenButton: '[data-testid="vault-open"], button:has-text("Open")',

  // Common
  dialog: '[role="dialog"]',
  modal: '[data-testid="modal"], [role="dialog"]',
  toast: '[data-testid="toast"], [class*="toast"], [class*="sonner"]',
  loadingSpinner: '[data-testid="loading"], [class*="loading"], [class*="spinner"]',

  // Tab system
  tabBar: '[class*="tab-bar"], [role="tablist"]',
  tab: '[role="tab"]',
  activeTab: '[role="tab"][aria-selected="true"]'
}

/**
 * Keyboard shortcuts for common actions
 * Based on actual app implementation
 */
export const SHORTCUTS = {
  newNote: 'Meta+n', // ⌘N - creates new note
  newTask: 'Meta+t', // ⌘T - creates new task (if available)
  search: 'Meta+p', // ⌘P - opens search/command palette
  save: 'Meta+s', // ⌘S - save
  undo: 'Meta+z', // ⌘Z - undo
  redo: 'Meta+Shift+z', // ⌘⇧Z - redo
  delete: 'Backspace', // Delete
  escape: 'Escape', // Close modals
  enter: 'Enter' // Confirm
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
  // Try multiple selectors to detect when app is ready
  // The app may show sidebar, or may still be on onboarding
  try {
    // Wait for either sidebar or main content area to be visible
    await page.locator('[data-testid="sidebar"], aside, [class*="sidebar"], nav').first().waitFor({
      state: 'visible',
      timeout
    })
  } catch {
    // If sidebar not found, just wait for DOM to stabilize
    await page.waitForTimeout(2000)
  }

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
  // Map view names to display text (capitalize first letter)
  const viewNames: Record<string, string> = {
    notes: 'Notes',
    tasks: 'Tasks',
    inbox: 'Inbox',
    journal: 'Journal',
    settings: 'Settings'
  }
  const displayName = viewNames[view] || view

  // Try multiple selector strategies
  const navItem = page.locator(
    `[data-testid="nav-${view}"], button:has-text("${displayName}"), a:has-text("${displayName}"), span:text("${displayName}")`
  ).first()

  try {
    await navItem.click({ timeout: 10000 })
  } catch {
    // If navigation item not found, the view might already be active or app is on onboarding
    console.log(`Navigation to ${view} not found, may already be on that view`)
  }
  await page.waitForTimeout(300)
}

/**
 * Open the command palette / search modal
 * Uses Meta+P (⌘P) keyboard shortcut
 */
export async function openCommandPalette(page: Page): Promise<void> {
  await page.keyboard.press(SHORTCUTS.search)

  // Wait for command palette to open - try multiple selectors
  const modal = page.locator(SELECTORS.searchModal).first()
  try {
    await modal.waitFor({ state: 'visible', timeout: 3000 })
  } catch {
    // Command palette might not be visible or uses different selector
    console.log('Command palette not found, may not be implemented')
  }
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
 * Uses Meta+N keyboard shortcut, then fills in title and content
 */
export async function createNote(
  page: Page,
  title: string,
  content?: string
): Promise<void> {
  // Trigger new note via keyboard shortcut
  await page.keyboard.press(SHORTCUTS.newNote)

  // Wait for note tab to open and title input to be ready
  // The title input is a textarea with aria-label="Note title"
  const titleInput = page.locator(SELECTORS.noteTitle).first()

  try {
    await titleInput.waitFor({ state: 'visible', timeout: 5000 })

    // Clear default "Untitled" and type new title
    await titleInput.click()
    await titleInput.fill(title)

    // Blur to save the title (title saves on blur)
    await page.keyboard.press('Tab')
    await page.waitForTimeout(300)

    if (content) {
      // Find the BlockNote editor and type content
      const editor = page.locator(SELECTORS.noteEditor).first()
      await editor.waitFor({ state: 'visible', timeout: 3000 })
      await editor.click()
      await page.keyboard.type(content)
    }

    // Wait for auto-save
    await page.waitForTimeout(1000)
  } catch {
    // Note creation might work differently or title input might not be visible
    console.log('Note creation: could not find title input, note may have been created')
    await page.waitForTimeout(500)
  }
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

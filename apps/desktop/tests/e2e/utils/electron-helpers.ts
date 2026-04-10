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
  noteEditor: '[aria-label="Rich text editor"] [contenteditable="true"]', // BlockNote editor input
  noteTitle: 'textarea[aria-label="Note title"]', // Title textarea
  noteTags: '[data-testid="note-tags"], [class*="tags-row"]',

  // Tasks - actual selectors from the app
  tasksList: '[data-testid="tasks-list"], [class*="task-list"]',
  taskItem: '[role="button"][aria-label*="Task:"], [data-testid="task-item"]',
  taskCheckbox: '[role="checkbox"], [data-testid="task-checkbox"]',
  addTaskButton: 'button:has-text("Add Task")', // Header button opens modal
  taskInput: 'input[aria-label="Quick add task"], input[placeholder*="Add task"]', // Quick add input
  taskModalTitleInput: '#task-title', // Title input in Add Task modal
  taskModal: '[role="dialog"]:has-text("Add Task")', // Add Task modal
  kanbanBoard: '[data-testid="kanban-board"], [class*="kanban"]',
  kanbanColumn: '[data-testid="kanban-column"], [class*="column"]',

  // Inbox
  inboxList: '[data-testid="inbox-list"], [class*="inbox-list"]',
  inboxItem: '[data-testid="inbox-item"], [class*="inbox-item"]',
  captureInput:
    '[data-testid="capture-input"], textarea[placeholder*="capture"], textarea[placeholder*="thought"]',

  // Journal
  journalEditor: '[data-testid="journal-editor"], .bn-editor',
  journalCalendar: '[data-testid="journal-calendar"], [class*="calendar"]',
  journalEntry: '[data-testid="journal-entry"], [class*="journal"]',

  // Vault
  vaultSwitcher: '[data-testid="vault-switcher"], button[title*="vault"]',
  vaultCreateButton: '[data-testid="vault-create"], button:has-text("Create")',
  vaultOpenButton: '[data-testid="vault-open"], button:has-text("Open")',

  // Common
  dialog: '[role="dialog"]',
  modal: '[data-testid="modal"], [role="dialog"]',
  toast: '[data-testid="toast"], [class*="toast"], [class*="sonner"]',
  loadingSpinner: '[data-testid="loading"], [class*="loading"], [class*="spinner"]',

  // Search
  searchResults: '[data-testid="search-results"], [class*="search-results"], [role="listbox"]',
  searchResultItem: '[data-testid="search-result-item"], [class*="search-result"], [role="option"]',
  searchInput:
    '[data-testid="search-input"], input[placeholder*="Search"], input[aria-label*="Search"]',

  // Tab system — scope to main tab bar (has data-group-id) to avoid matching
  // secondary tab bars like the Tasks view's sub-tab bar (role="tablist" only).
  tabBar: '[role="tablist"][data-group-id]',
  tab: '[role="tab"][data-group-id]',
  activeTab: '[role="tab"][data-group-id][aria-selected="true"]',
  tabCloseButton: '[role="tab"][data-group-id] button[aria-label^="Close"]',

  // Split view
  splitViewContainer: '[data-testid="split-view-container"]',
  splitPane: '[data-testid="split-pane"]',
  tabPane: '[data-testid="tab-pane"]',
  emptyPaneState: '[data-testid="empty-pane-state"]',
  tabContent: '[data-tab-content]',

  // Sidebar trigger (inside tab bar)
  sidebarTrigger: '[data-testid="tab-pane"] button, [role="tablist"] button'
}

const FIRST_RUN_ONBOARDING = {
  root: 'button[aria-label="Skip onboarding"]',
  skipButton: 'button[aria-label="Skip onboarding"]'
} as const

/**
 * Keyboard shortcuts for common actions
 * Based on actual app implementation
 */
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

export const SHORTCUTS = {
  newNote: `${MOD}+n`,
  newTask: `${MOD}+t`,
  save: `${MOD}+s`,
  undo: `${MOD}+z`,
  redo: `${MOD}+Shift+z`,
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

  await dismissFirstRunOnboarding(page)
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

  await dismissFirstRunOnboarding(page)
}

/**
 * Navigate to a specific page/view in the app
 */
export async function navigateTo(
  page: Page,
  view: 'notes' | 'tasks' | 'inbox' | 'journal' | 'settings'
): Promise<void> {
  await dismissFirstRunOnboarding(page)

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
  const navItem = page
    .locator(
      `[data-testid="nav-${view}"], button:has-text("${displayName}"), a:has-text("${displayName}"), span:text("${displayName}")`
    )
    .first()

  try {
    await navItem.click({ timeout: 10000 })
  } catch {
    // If navigation item not found, the view might already be active or app is on onboarding
    console.log(`Navigation to ${view} not found, may already be on that view`)
  }
  await page.waitForTimeout(300)
}

export async function dismissFirstRunOnboarding(page: Page, timeout = 3000): Promise<void> {
  const skipButton = page.locator(FIRST_RUN_ONBOARDING.skipButton).first()
  const overlayVisible = await page
    .locator(FIRST_RUN_ONBOARDING.root)
    .first()
    .isVisible({ timeout })
    .catch(() => false)

  if (!overlayVisible) {
    return
  }

  await skipButton.click({ force: true })
  await skipButton.waitFor({ state: 'hidden', timeout }).catch(() => {})
  await page.waitForTimeout(300)
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
export async function createNote(page: Page, title: string, content?: string): Promise<void> {
  // Trigger new note via keyboard shortcut
  await page.keyboard.press(SHORTCUTS.newNote)

  // Wait for note tab to open and title input to be ready
  // The title input is a textarea with aria-label="Note title"
  const titleInput = page.locator(SELECTORS.noteTitle).first()

  let titleTyped = false
  try {
    await titleInput.waitFor({ state: 'visible', timeout: 10000 })

    // Clear default "Untitled" and type new title
    await titleInput.click()
    await titleInput.fill(title)

    // Blur to save the title (title saves on blur)
    await page.keyboard.press('Tab')
    await page.waitForTimeout(300)
    titleTyped = true
  } catch {
    console.log('Note creation: could not find title input, note may have been created')
    await page.waitForTimeout(500)
  }

  // Type content even if title-typing failed — the note tab is still open
  // and the editor should be mounted.
  if (content) {
    try {
      const editor = page.locator(SELECTORS.noteEditor).first()
      await editor.waitFor({ state: 'visible', timeout: 3000 })
      await editor.click()
      await page.keyboard.type(content)
    } catch {
      console.log('Note creation: could not find editor to type content')
    }
  }

  // Wait for auto-save
  await page.waitForTimeout(titleTyped ? 1000 : 500)
}

/**
 * Create a new task via UI
 * Tries multiple strategies:
 * 1. Quick Add input (fastest - type and press Enter)
 * 2. Add Task button -> modal flow
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
  try {
    await dismissFirstRunOnboarding(page)

    // Strategy 1: Try Quick Add input (inline input in task list)
    const quickAddInput = page.locator(SELECTORS.taskInput).first()
    const hasQuickAdd = await quickAddInput.isVisible({ timeout: 2000 }).catch(() => false)

    if (hasQuickAdd) {
      await quickAddInput.click()
      await quickAddInput.fill(title)
      await quickAddInput.press('Enter')
      await page.waitForTimeout(500)
      return
    }

    // Strategy 2: Try Add Task button (opens modal)
    const addButton = page.locator(SELECTORS.addTaskButton).first()
    const hasAddButton = await addButton.isVisible({ timeout: 2000 }).catch(() => false)

    if (hasAddButton) {
      await addButton.click()
      await page.waitForTimeout(300)

      // Wait for modal to open
      const modal = page.locator(SELECTORS.taskModal).first()
      const modalOpened = await modal
        .waitFor({ state: 'visible', timeout: 2000 })
        .then(() => true)
        .catch(() => false)

      if (modalOpened) {
        // Fill in title in modal
        const titleInput = page.locator(SELECTORS.taskModalTitleInput)
        await titleInput.fill(title)

        // Submit with Cmd+Enter or click Add Task button
        await page.keyboard.press('Meta+Enter')
        await page.waitForTimeout(500)
        return
      }
    }

    console.log('Task creation: no task input found, UI may not be ready')
    await page.waitForTimeout(500)
  } catch (error) {
    console.log('Task creation: could not create task -', error)
    await page.waitForTimeout(500)
  }
}

/**
 * Toggle task completion by clicking the checkbox
 * Task items have aria-label="Task: {title}, ..."
 */
export async function toggleTaskCompletion(page: Page, taskTitle: string): Promise<void> {
  try {
    // Find task by aria-label containing the title
    const task = page
      .locator(`[role="button"][aria-label*="Task:"][aria-label*="${taskTitle}"]`)
      .first()
    const taskVisible = await task.isVisible({ timeout: 2000 }).catch(() => false)

    if (taskVisible) {
      const checkbox = task.locator(SELECTORS.taskCheckbox).first()
      await checkbox.click({ force: true })
      await page.waitForTimeout(300)
      return
    }

    const taskByText = page.locator(`${SELECTORS.taskItem}:has-text("${taskTitle}")`).first()
    if (await taskByText.isVisible().catch(() => false)) {
      const checkbox = taskByText.locator(SELECTORS.taskCheckbox).first()
      await checkbox.click({ force: true })
      await page.waitForTimeout(300)
    }
  } catch {
    console.log(`Toggle task completion: could not find task "${taskTitle}"`)
  }
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
export async function waitForToast(page: Page, text: string, timeout = 5000): Promise<void> {
  const toast = page.locator(`${SELECTORS.toast}:has-text("${text}")`)
  await toast.waitFor({ state: 'visible', timeout })
}

/**
 * Take a screenshot with a descriptive name
 */
export async function takeScreenshot(page: Page, name: string): Promise<void> {
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
export async function isVisible(page: Page, selector: string): Promise<boolean> {
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
export async function getElementCount(page: Page, selector: string): Promise<number> {
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
export async function getAppVersion(electronApp: ElectronApplication): Promise<string> {
  return electronApp.evaluate(async ({ app }) => {
    return app.getVersion()
  })
}

/**
 * Check if app is in development mode
 */
export async function isDevelopment(electronApp: ElectronApplication): Promise<boolean> {
  return electronApp.evaluate(async () => {
    return process.env.NODE_ENV === 'development'
  })
}

/**
 * Open search and type a query.
 * Uses Cmd/Ctrl+K or the search input directly.
 */
export async function search(page: Page, query: string): Promise<void> {
  try {
    await page.keyboard.press(`${MOD}+k`)
    await page.waitForTimeout(300)

    const searchInput = page.locator(SELECTORS.searchInput).first()
    const hasInput = await searchInput.isVisible({ timeout: 2000 }).catch(() => false)

    if (hasInput) {
      await searchInput.fill(query)
      await page.waitForTimeout(500)
      return
    }

    const cmdPaletteInput = page
      .locator('input[placeholder*="Search"], input[role="combobox"]')
      .first()
    if (await cmdPaletteInput.isVisible({ timeout: 1000 }).catch(() => false)) {
      await cmdPaletteInput.fill(query)
      await page.waitForTimeout(500)
    }
  } catch {
    console.log(`Search: could not execute search for "${query}"`)
  }
}

/**
 * Select a result from the search results list
 */
export async function selectSearchResult(page: Page, text: string): Promise<void> {
  try {
    const result = page.locator(SELECTORS.searchResultItem).filter({ hasText: text }).first()
    const isVisible = await result.isVisible({ timeout: 3000 }).catch(() => false)
    if (isVisible) {
      await result.click()
      await page.waitForTimeout(300)
    }
  } catch {
    console.log(`Select search result: could not find "${text}"`)
  }
}

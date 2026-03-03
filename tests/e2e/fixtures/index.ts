/**
 * E2E Test Fixtures
 *
 * Provides sample data and vault templates for E2E tests.
 */

import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'

/**
 * Path to the test vault template
 */
export const TEST_VAULT_TEMPLATE = path.join(__dirname, 'test-vault')

/**
 * Sample note data for testing
 */
export const SAMPLE_NOTES = {
  gettingStarted: {
    id: 'note-getting-started',
    title: 'Getting Started',
    tags: ['tutorial', 'onboarding']
  },
  sampleProject: {
    id: 'note-sample-project',
    title: 'Sample Project',
    tags: ['project', 'active']
  }
}

/**
 * Sample task data for testing
 */
export const SAMPLE_TASKS = {
  basic: {
    title: 'Test Task',
    description: 'A basic test task',
    priority: 2
  },
  withDueDate: {
    title: 'Task with Due Date',
    dueDate: new Date().toISOString().split('T')[0],
    priority: 1
  },
  subtask: {
    title: 'Parent Task',
    subtasks: [{ title: 'Subtask 1' }, { title: 'Subtask 2' }]
  },
  recurring: {
    title: 'Recurring Task',
    repeat: {
      type: 'daily',
      interval: 1
    }
  }
}

/**
 * Sample inbox items for testing
 */
export const SAMPLE_INBOX_ITEMS = {
  text: {
    type: 'text',
    content: 'Quick note from clipboard'
  },
  link: {
    type: 'link',
    url: 'https://example.com/article',
    title: 'Sample Article'
  }
}

/**
 * Create a temporary test vault from template
 */
export function createTestVault(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-e2e-'))

  // Copy template vault structure
  copyDirRecursive(TEST_VAULT_TEMPLATE, tempDir)

  return tempDir
}

/**
 * Clean up a test vault
 */
export function cleanupTestVault(vaultPath: string): void {
  if (vaultPath.includes('memry-e2e-')) {
    fs.rmSync(vaultPath, { recursive: true, force: true })
  }
}

/**
 * Helper to recursively copy directory
 */
function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true })

  const entries = fs.readdirSync(src, { withFileTypes: true })

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)

    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath)
    } else {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}

/**
 * Wait for vault to be ready (indexed)
 */
export async function waitForVaultReady(timeout = 10000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

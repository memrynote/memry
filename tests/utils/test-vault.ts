/**
 * Temporary vault directory factory for testing.
 * Creates isolated vault structures for file system tests.
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

export interface TestVaultResult {
  path: string
  memryDir: string
  notesDir: string
  journalDir: string
  attachmentsDir: string
  dataDbPath: string
  indexDbPath: string
  configPath: string
  cleanup: () => void
}

// ============================================================================
// Vault Factory
// ============================================================================

/**
 * Create a temporary vault directory with full structure.
 */
export function createTestVault(name = 'test-vault'): TestVaultResult {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `memry-${name}-`))

  const memryDir = path.join(tempDir, '.memry')
  const notesDir = path.join(tempDir, 'notes')
  const journalDir = path.join(tempDir, 'journal')
  const attachmentsDir = path.join(tempDir, 'attachments')
  const imagesDir = path.join(attachmentsDir, 'images')
  const filesDir = path.join(attachmentsDir, 'files')

  // Create directory structure
  fs.mkdirSync(memryDir, { recursive: true })
  fs.mkdirSync(notesDir, { recursive: true })
  fs.mkdirSync(journalDir, { recursive: true })
  fs.mkdirSync(imagesDir, { recursive: true })
  fs.mkdirSync(filesDir, { recursive: true })

  // Create config.json
  const configPath = path.join(memryDir, 'config.json')
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        excludePatterns: ['.git', 'node_modules', '.trash'],
        defaultNoteFolder: 'notes',
        journalFolder: 'journal',
        attachmentsFolder: 'attachments'
      },
      null,
      2
    )
  )

  const dataDbPath = path.join(memryDir, 'data.db')
  const indexDbPath = path.join(memryDir, 'index.db')

  return {
    path: tempDir,
    memryDir,
    notesDir,
    journalDir,
    attachmentsDir,
    dataDbPath,
    indexDbPath,
    configPath,
    cleanup: () => {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true })
      } catch (error) {
        console.warn(`Failed to cleanup test vault: ${tempDir}`, error)
      }
    }
  }
}

// ============================================================================
// Note File Utilities
// ============================================================================

export interface CreateNoteOptions {
  id?: string
  title: string
  content?: string
  tags?: string[]
  folder?: string
  properties?: Record<string, unknown>
}

/**
 * Create a test note file in the vault.
 */
export function createTestNote(vault: TestVaultResult, options: CreateNoteOptions): string {
  const id = options.id || `note-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  const folder = options.folder ? path.join(vault.notesDir, options.folder) : vault.notesDir
  const filename = `${options.title.replace(/[^a-zA-Z0-9-_]/g, '-')}.md`
  const filePath = path.join(folder, filename)

  // Ensure folder exists
  fs.mkdirSync(folder, { recursive: true })

  // Build frontmatter
  const frontmatter: Record<string, unknown> = {
    id,
    title: options.title
  }

  if (options.tags && options.tags.length > 0) {
    frontmatter.tags = options.tags
  }

  if (options.properties) {
    Object.assign(frontmatter, options.properties)
  }

  // Build file content
  const yamlContent = Object.entries(frontmatter)
    .map(([key, value]) => {
      if (Array.isArray(value)) {
        return `${key}:\n${value.map((v) => `  - ${v}`).join('\n')}`
      }
      return `${key}: ${JSON.stringify(value)}`
    })
    .join('\n')

  const fileContent = `---\n${yamlContent}\n---\n\n${options.content || ''}`

  fs.writeFileSync(filePath, fileContent, 'utf8')

  return filePath
}

/**
 * Create a test journal entry file.
 */
export function createTestJournalEntry(
  vault: TestVaultResult,
  date: string,
  content = ''
): string {
  const [year, month] = date.split('-')
  const yearDir = path.join(vault.journalDir, year)
  const monthDir = path.join(yearDir, month)

  fs.mkdirSync(monthDir, { recursive: true })

  const filePath = path.join(monthDir, `${date}.md`)
  const fileContent = `---\ndate: ${date}\n---\n\n${content}`

  fs.writeFileSync(filePath, fileContent, 'utf8')

  return filePath
}

/**
 * Read a note file and parse its frontmatter.
 */
export function readTestNote(filePath: string): {
  frontmatter: Record<string, unknown>
  content: string
} {
  const fileContent = fs.readFileSync(filePath, 'utf8')

  const match = fileContent.match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/)

  if (!match) {
    return { frontmatter: {}, content: fileContent }
  }

  // Simple YAML parsing (for tests only)
  const frontmatter: Record<string, unknown> = {}
  const yamlLines = match[1].split('\n')

  for (const line of yamlLines) {
    const colonIndex = line.indexOf(':')
    if (colonIndex > 0) {
      const key = line.substring(0, colonIndex).trim()
      const value = line.substring(colonIndex + 1).trim()
      try {
        frontmatter[key] = JSON.parse(value)
      } catch {
        frontmatter[key] = value
      }
    }
  }

  return {
    frontmatter,
    content: match[2]
  }
}

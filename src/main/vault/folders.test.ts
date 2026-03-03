/**
 * Tests for folders.ts
 * Tests folder configuration operations for template settings.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  readFolderConfig,
  writeFolderConfig,
  getFolderTemplate,
  setFolderTemplate,
  isFolderConfigFile
} from './folders'

// ============================================================================
// Test Helpers
// ============================================================================

interface TestDir {
  path: string
  cleanup: () => void
}

function createTempVault(prefix = 'folders-test-'): TestDir {
  const tempPath = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  // Create notes folder
  fs.mkdirSync(path.join(tempPath, 'notes'), { recursive: true })
  return {
    path: tempPath,
    cleanup: () => {
      try {
        fs.rmSync(tempPath, { recursive: true, force: true })
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

// ============================================================================
// Mock Setup
// ============================================================================

// Store the mock vault path
let mockVaultPath = '/mock/vault'

// Mock the vault/index module
vi.mock('./index', () => ({
  getStatus: vi.fn(() => ({ path: mockVaultPath, isOpen: true })),
  getConfig: vi.fn(() => ({
    defaultNoteFolder: 'notes',
    journalFolder: 'journal',
    attachmentsFolder: 'attachments',
    excludePatterns: []
  }))
}))

// ============================================================================
// Pure Function Tests (T401)
// ============================================================================

describe('isFolderConfigFile', () => {
  it('T401: returns true for .folder.md', () => {
    expect(isFolderConfigFile('.folder.md')).toBe(true)
    expect(isFolderConfigFile('/path/to/.folder.md')).toBe(true)
    expect(isFolderConfigFile('notes/projects/.folder.md')).toBe(true)
  })

  it('T401: returns false for other files', () => {
    expect(isFolderConfigFile('folder.md')).toBe(false)
    expect(isFolderConfigFile('.folder.txt')).toBe(false)
    expect(isFolderConfigFile('note.md')).toBe(false)
  })
})

// ============================================================================
// Folder Config Tests (T398-T400)
// ============================================================================

describe('folder config operations', () => {
  let tempVault: TestDir
  let mockGetStatus: ReturnType<typeof vi.fn>
  let mockGetConfig: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    tempVault = createTempVault()
    mockVaultPath = tempVault.path

    // Get the mock functions and update their return values
    const indexModule = await import('./index')
    mockGetStatus = indexModule.getStatus as ReturnType<typeof vi.fn>
    mockGetConfig = indexModule.getConfig as ReturnType<typeof vi.fn>

    mockGetStatus.mockReturnValue({ path: tempVault.path, isOpen: true })
    mockGetConfig.mockReturnValue({
      defaultNoteFolder: 'notes',
      journalFolder: 'journal',
      attachmentsFolder: 'attachments',
      excludePatterns: []
    })
  })

  afterEach(() => {
    tempVault.cleanup()
  })

  describe('readFolderConfig', () => {
    it('T398: returns null for non-existent config', async () => {
      const config = await readFolderConfig('projects')

      expect(config).toBeNull()
    })

    it('T398: reads and parses .folder.md file', async () => {
      // Create folder config
      const projectsDir = path.join(tempVault.path, 'notes', 'projects')
      fs.mkdirSync(projectsDir, { recursive: true })
      fs.writeFileSync(
        path.join(projectsDir, '.folder.md'),
        `---
template: project-template
inherit: false
---
`
      )

      const config = await readFolderConfig('projects')

      expect(config).not.toBeNull()
      expect(config!.template).toBe('project-template')
      expect(config!.inherit).toBe(false)
    })

    it('T398: reads root folder config', async () => {
      fs.writeFileSync(
        path.join(tempVault.path, 'notes', '.folder.md'),
        `---
template: default-template
---
`
      )

      // Empty string or '.' should read root config
      const config = await readFolderConfig('')

      expect(config).not.toBeNull()
      expect(config!.template).toBe('default-template')
    })

    it('T398: parses view configuration', async () => {
      const projectsDir = path.join(tempVault.path, 'notes', 'projects')
      fs.mkdirSync(projectsDir, { recursive: true })
      fs.writeFileSync(
        path.join(projectsDir, '.folder.md'),
        `---
views:
  - name: Table View
    type: table
formulas:
  computed: "1 + 1"
properties:
  status:
    type: select
    options:
      - active
      - done
summaries:
  status:
    type: count
---
`
      )

      const config = await readFolderConfig('projects')

      expect(config!.views).toHaveLength(1)
      expect(config!.views![0].name).toBe('Table View')
      expect(config!.formulas).toEqual({ computed: '1 + 1' })
      expect((config!.properties!.status as Record<string, unknown>).type).toBe('select')
      expect((config!.summaries!.status as unknown as Record<string, unknown>).type).toBe('count')
    })
  })

  describe('writeFolderConfig', () => {
    it('T398: writes config to .folder.md file', async () => {
      await writeFolderConfig('projects', { template: 'project-template' })

      const filePath = path.join(tempVault.path, 'notes', 'projects', '.folder.md')
      expect(fs.existsSync(filePath)).toBe(true)

      const content = fs.readFileSync(filePath, 'utf-8')
      expect(content).toContain('template: project-template')
    })

    it('T398: creates folder if not exists', async () => {
      await writeFolderConfig('new-folder', { template: 'test' })

      const folderPath = path.join(tempVault.path, 'notes', 'new-folder')
      expect(fs.existsSync(folderPath)).toBe(true)
    })

    it('T398: deletes file if config is empty', async () => {
      // Create a config first
      const projectsDir = path.join(tempVault.path, 'notes', 'projects')
      fs.mkdirSync(projectsDir, { recursive: true })
      fs.writeFileSync(path.join(projectsDir, '.folder.md'), 'template: old')

      // Write empty config
      await writeFolderConfig('projects', {})

      const filePath = path.join(projectsDir, '.folder.md')
      expect(fs.existsSync(filePath)).toBe(false)
    })

    it('T398: preserves views configuration', async () => {
      const views = [{ name: 'Table', type: 'table' as const }]
      await writeFolderConfig('projects', { views })

      const config = await readFolderConfig('projects')
      expect(config!.views).toHaveLength(1)
    })
  })

  describe('getFolderTemplate', () => {
    it('T399: returns template from folder config', async () => {
      const projectsDir = path.join(tempVault.path, 'notes', 'projects')
      fs.mkdirSync(projectsDir, { recursive: true })
      fs.writeFileSync(
        path.join(projectsDir, '.folder.md'),
        `---
template: project-template
---
`
      )

      const template = await getFolderTemplate('projects')

      expect(template).toBe('project-template')
    })

    it('T399: inherits template from parent folder', async () => {
      // Set template on root
      fs.writeFileSync(
        path.join(tempVault.path, 'notes', '.folder.md'),
        `---
template: root-template
---
`
      )

      // Create subfolder without config
      const projectsDir = path.join(tempVault.path, 'notes', 'projects')
      fs.mkdirSync(projectsDir, { recursive: true })

      const template = await getFolderTemplate('projects')

      expect(template).toBe('root-template')
    })

    it('T399: stops inheritance when inherit is false', async () => {
      // Set template on root
      fs.writeFileSync(
        path.join(tempVault.path, 'notes', '.folder.md'),
        `---
template: root-template
---
`
      )

      // Set inherit: false on subfolder
      const projectsDir = path.join(tempVault.path, 'notes', 'projects')
      fs.mkdirSync(projectsDir, { recursive: true })
      fs.writeFileSync(
        path.join(projectsDir, '.folder.md'),
        `---
inherit: false
---
`
      )

      const template = await getFolderTemplate('projects')

      expect(template).toBeNull()
    })

    it('T399: returns null when no template in hierarchy', async () => {
      const template = await getFolderTemplate('projects')

      expect(template).toBeNull()
    })

    it('T399: traverses multiple levels', async () => {
      // Set template on parent
      const projectsDir = path.join(tempVault.path, 'notes', 'projects')
      fs.mkdirSync(projectsDir, { recursive: true })
      fs.writeFileSync(
        path.join(projectsDir, '.folder.md'),
        `---
template: projects-template
---
`
      )

      // Create nested subfolder
      const activeDir = path.join(projectsDir, 'active')
      fs.mkdirSync(activeDir, { recursive: true })

      const template = await getFolderTemplate('projects/active')

      expect(template).toBe('projects-template')
    })
  })

  describe('setFolderTemplate', () => {
    it('T400: sets template in folder config', async () => {
      await setFolderTemplate('projects', 'new-template')

      const config = await readFolderConfig('projects')
      expect(config!.template).toBe('new-template')
    })

    it('T400: clears template when null', async () => {
      // First set a template
      await setFolderTemplate('projects', 'temp')

      // Then clear it
      await setFolderTemplate('projects', null)

      const config = await readFolderConfig('projects')
      // Config should be null (file deleted) or template undefined
      expect(config === null || config.template === undefined).toBe(true)
    })

    it('T400: preserves other config values', async () => {
      // Create config with views
      await writeFolderConfig('projects', {
        views: [{ name: 'Table', type: 'table' }]
      })

      // Set template
      await setFolderTemplate('projects', 'my-template')

      const config = await readFolderConfig('projects')
      expect(config!.template).toBe('my-template')
      expect(config!.views).toHaveLength(1)
    })
  })
})

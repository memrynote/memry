/**
 * Tests for templates.ts
 * Tests template CRUD operations and template application.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  getTemplatesDir,
  ensureTemplatesDir,
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  duplicateTemplate,
  applyTemplate
} from './templates'
import type { Template } from '@memry/contracts/templates-api'
import { VaultError } from '../lib/errors'

// ============================================================================
// Test Helpers
// ============================================================================

interface TestDir {
  path: string
  cleanup: () => void
}

function createTempVault(prefix = 'templates-test-'): TestDir {
  const tempPath = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  // Create .memry folder
  fs.mkdirSync(path.join(tempPath, '.memry'), { recursive: true })
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
  getStatus: vi.fn(() => ({ path: mockVaultPath, isOpen: true }))
}))

// Mock the vault/init module
vi.mock('./init', () => ({
  getMemryDir: vi.fn((vaultPath: string) => path.join(vaultPath, '.memry'))
}))

// Mock BrowserWindow for event emission
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => [])
  }
}))

const FIXED_ISO = '2026-01-15T12:00:00.000Z'

// ============================================================================
// applyTemplate Tests (T389) - Pure function, no mocking needed
// ============================================================================

describe('applyTemplate', () => {
  it('T389: replaces {{title}} placeholder with actual title', () => {
    const template: Template = {
      id: 'test-template',
      name: 'Test Template',
      description: 'Test',
      icon: null,
      isBuiltIn: false,
      tags: [],
      properties: [],
      content: '# {{title}}\n\nContent for {{title}}',
      createdAt: FIXED_ISO,
      modifiedAt: FIXED_ISO
    }

    const result = applyTemplate(template, 'My Note')

    expect(result.content).toBe('# My Note\n\nContent for My Note')
  })

  it('T389: copies tags from template', () => {
    const template: Template = {
      id: 'test-template',
      name: 'Test Template',
      description: undefined,
      icon: null,
      isBuiltIn: false,
      tags: ['project', 'active'],
      properties: [],
      content: '',
      createdAt: FIXED_ISO,
      modifiedAt: FIXED_ISO
    }

    const result = applyTemplate(template, 'My Note')

    expect(result.tags).toEqual(['project', 'active'])
  })

  it('T389: converts properties array to record', () => {
    const template: Template = {
      id: 'test-template',
      name: 'Test Template',
      description: undefined,
      icon: null,
      isBuiltIn: false,
      tags: [],
      properties: [
        { name: 'status', type: 'select', value: 'draft', options: ['draft', 'published'] },
        { name: 'priority', type: 'rating', value: 3 }
      ],
      content: '',
      createdAt: FIXED_ISO,
      modifiedAt: FIXED_ISO
    }

    const result = applyTemplate(template, 'My Note')

    expect(result.properties).toEqual({
      status: 'draft',
      priority: 3
    })
  })

  it('T389: handles template without properties', () => {
    const template: Template = {
      id: 'blank',
      name: 'Blank',
      description: undefined,
      icon: null,
      isBuiltIn: true,
      tags: [],
      properties: [],
      content: '',
      createdAt: FIXED_ISO,
      modifiedAt: FIXED_ISO
    }

    const result = applyTemplate(template, 'My Note')

    expect(result.properties).toEqual({})
    expect(result.tags).toEqual([])
    expect(result.content).toBe('')
  })
})

// ============================================================================
// Template CRUD Tests (T384-T388)
// ============================================================================

describe('template CRUD operations', () => {
  let tempVault: TestDir
  let mockGetStatus: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    tempVault = createTempVault()
    mockVaultPath = tempVault.path

    // Get the mock functions and update their return values
    const indexModule = await import('./index')
    mockGetStatus = indexModule.getStatus as ReturnType<typeof vi.fn>
    mockGetStatus.mockReturnValue({ path: tempVault.path, isOpen: true })

    vi.useFakeTimers()
    vi.setSystemTime(new Date(FIXED_ISO))
  })

  afterEach(() => {
    vi.useRealTimers()
    tempVault.cleanup()
  })

  describe('getTemplatesDir', () => {
    it('T385: returns templates directory inside .memry', () => {
      const result = getTemplatesDir()

      expect(result).toBe(path.join(tempVault.path, '.memry', 'templates'))
    })
  })

  describe('ensureTemplatesDir', () => {
    it('T385: creates templates directory if not exists', async () => {
      await ensureTemplatesDir()

      const templatesDir = path.join(tempVault.path, '.memry', 'templates')
      expect(fs.existsSync(templatesDir)).toBe(true)
    })

    it('T385: seeds built-in templates', async () => {
      await ensureTemplatesDir()

      const templatesDir = path.join(tempVault.path, '.memry', 'templates')
      const files = fs.readdirSync(templatesDir)

      // Should have at least the built-in templates
      expect(files.length).toBeGreaterThan(0)
      expect(files).toContain('blank.md')
    })
  })

  describe('listTemplates', () => {
    it('T386: lists all templates', async () => {
      const templates = await listTemplates()

      // Should have built-in templates
      expect(templates.length).toBeGreaterThan(0)

      // Find blank template
      const blank = templates.find((t) => t.id === 'blank')
      expect(blank).toBeDefined()
      expect(blank!.isBuiltIn).toBe(true)
    })

    it('T386: sorts built-in first, then by name', async () => {
      // Create a custom template
      await createTemplate({ name: 'AAA Custom', tags: [], properties: [], content: '' })

      const templates = await listTemplates()

      // First templates should be built-in
      const firstBuiltIn = templates.findIndex((t) => t.isBuiltIn)
      const firstCustom = templates.findIndex((t) => !t.isBuiltIn)

      if (firstBuiltIn !== -1 && firstCustom !== -1) {
        expect(firstBuiltIn).toBeLessThan(firstCustom)
      }
    })
  })

  describe('getTemplate', () => {
    it('T386: returns template by ID', async () => {
      await ensureTemplatesDir()

      const template = await getTemplate('blank')

      expect(template).not.toBeNull()
      expect(template!.id).toBe('blank')
      expect(template!.name).toBe('Blank Note')
    })

    it('T386: returns null for non-existent template', async () => {
      await ensureTemplatesDir()

      const template = await getTemplate('nonexistent')

      expect(template).toBeNull()
    })
  })

  describe('createTemplate', () => {
    it('T387: creates new template file', async () => {
      const template = await createTemplate({
        name: 'My Template',
        description: 'A custom template',
        icon: '📋',
        tags: ['custom'],
        content: '# {{title}}\n\nCustom content',
        properties: []
      })

      expect(template.name).toBe('My Template')
      expect(template.description).toBe('A custom template')
      expect(template.icon).toBe('📋')
      expect(template.tags).toEqual(['custom'])
      expect(template.isBuiltIn).toBe(false)
      expect(template.id).toBeTruthy()
    })

    it('T387: writes template to disk', async () => {
      const template = await createTemplate({
        name: 'Disk Test',
        tags: [],
        properties: [],
        content: ''
      })

      const filePath = path.join(tempVault.path, '.memry', 'templates', `${template.id}.md`)
      expect(fs.existsSync(filePath)).toBe(true)
    })
  })

  describe('updateTemplate', () => {
    it('T387: updates existing template', async () => {
      const created = await createTemplate({
        name: 'Original',
        tags: [],
        properties: [],
        content: ''
      })

      const updated = await updateTemplate({
        id: created.id,
        name: 'Updated Name',
        content: 'New content'
      })

      expect(updated.name).toBe('Updated Name')
      expect(updated.content).toBe('New content')
    })

    it('T387: throws error for built-in templates', async () => {
      await ensureTemplatesDir()

      await expect(
        updateTemplate({
          id: 'blank',
          name: 'Modified Blank'
        })
      ).rejects.toThrow(VaultError)
    })

    it('T387: throws error for non-existent template', async () => {
      await expect(
        updateTemplate({
          id: 'nonexistent',
          name: 'Test'
        })
      ).rejects.toThrow(VaultError)
    })
  })

  describe('deleteTemplate', () => {
    it('T388: deletes custom template', async () => {
      const template = await createTemplate({
        name: 'To Delete',
        tags: [],
        properties: [],
        content: ''
      })

      await deleteTemplate(template.id)

      const filePath = path.join(tempVault.path, '.memry', 'templates', `${template.id}.md`)
      expect(fs.existsSync(filePath)).toBe(false)
    })

    it('T388: throws error for built-in templates', async () => {
      await ensureTemplatesDir()

      await expect(deleteTemplate('blank')).rejects.toThrow(VaultError)
    })

    it('T388: throws error for non-existent template', async () => {
      await expect(deleteTemplate('nonexistent')).rejects.toThrow(VaultError)
    })
  })

  describe('duplicateTemplate', () => {
    it('T388: creates copy with new name', async () => {
      await ensureTemplatesDir()

      const duplicate = await duplicateTemplate('blank', 'My Blank Copy')

      expect(duplicate.name).toBe('My Blank Copy')
      expect(duplicate.isBuiltIn).toBe(false)
      expect(duplicate.id).not.toBe('blank')
    })

    it('T388: preserves content and tags', async () => {
      const original = await createTemplate({
        tags: ['tag1', 'tag2'],
        properties: [],
        content: 'Template content',
        name: 'Original'
      })

      const duplicate = await duplicateTemplate(original.id, 'Copy')

      expect(duplicate.content).toBe('Template content')
      expect(duplicate.tags).toEqual(['tag1', 'tag2'])
    })

    it('T388: throws error for non-existent template', async () => {
      await expect(duplicateTemplate('nonexistent', 'Copy')).rejects.toThrow(VaultError)
    })
  })
})

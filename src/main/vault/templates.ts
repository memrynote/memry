/**
 * Template CRUD operations.
 * Templates are stored as markdown files in vault/.memry/templates/
 *
 * @module vault/templates
 */

import path from 'path'
import fs from 'fs/promises'
import { existsSync, mkdirSync } from 'fs'
import { BrowserWindow } from 'electron'
import matter from 'gray-matter'
import { getStatus } from './index'
import { getMemryDir } from './init'
import { VaultError, VaultErrorCode } from '../lib/errors'
import { generateNoteId } from '../lib/id'
import { TemplatesChannels } from '@shared/ipc-channels'
import type {
  Template,
  TemplateListItem,
  TemplateCreateInput,
  TemplateUpdateInput,
  TemplateProperty
} from '@shared/contracts/templates-api'

// ============================================================================
// Constants
// ============================================================================

const TEMPLATES_DIR = 'templates'

// ============================================================================
// Built-in Templates
// ============================================================================

const BUILT_IN_TEMPLATES: Omit<Template, 'createdAt' | 'modifiedAt'>[] = [
  {
    id: 'blank',
    name: 'Blank Note',
    description: 'Start with an empty note',
    icon: '📄',
    isBuiltIn: true,
    tags: [],
    properties: [],
    content: ''
  },
  {
    id: 'meeting-notes',
    name: 'Meeting Notes',
    description: 'Meeting agenda and notes template',
    icon: '📝',
    isBuiltIn: true,
    tags: ['meeting'],
    properties: [
      { name: 'date', type: 'date', value: null },
      { name: 'attendees', type: 'text', value: '' },
      {
        name: 'status',
        type: 'select',
        value: 'scheduled',
        options: ['scheduled', 'completed', 'cancelled']
      }
    ],
    content: `# {{title}}

## Attendees

- 

## Agenda

1. 
2. 
3. 

## Notes

## Action Items

- [ ] 
`
  },
  {
    id: 'project-brief',
    name: 'Project Brief',
    description: 'Template for project documentation',
    icon: '📋',
    isBuiltIn: true,
    tags: ['project'],
    properties: [
      {
        name: 'status',
        type: 'select',
        value: 'planning',
        options: ['planning', 'active', 'on-hold', 'completed']
      },
      { name: 'priority', type: 'rating', value: 3 },
      { name: 'startDate', type: 'date', value: null },
      { name: 'dueDate', type: 'date', value: null }
    ],
    content: `# {{title}}

## Overview

Brief description of the project...

## Goals

- 
- 

## Scope

### In Scope

- 

### Out of Scope

- 

## Timeline

## Notes

`
  },
  {
    id: 'daily-standup',
    name: 'Daily Standup',
    description: 'Daily standup format',
    icon: '✅',
    isBuiltIn: true,
    tags: ['standup', 'daily'],
    properties: [{ name: 'date', type: 'date', value: null }],
    content: `# {{title}}

## What I did yesterday

- 

## What I'm doing today

- 

## Blockers

- 
`
  },
  // ===========================================================================
  // Journal Templates
  // ===========================================================================
  {
    id: 'morning-pages',
    name: 'Morning Pages',
    description: 'Stream of consciousness writing to start your day',
    icon: '🌅',
    isBuiltIn: true,
    tags: ['morning', 'reflection'],
    properties: [
      {
        name: 'mood',
        type: 'select',
        value: 'neutral',
        options: ['great', 'good', 'neutral', 'low', 'difficult']
      }
    ],
    content: `# Morning Pages

Write freely for the next few minutes. Don't worry about grammar, spelling, or making sense. Just let your thoughts flow...

---

`
  },
  {
    id: 'daily-reflection',
    name: 'Daily Reflection',
    description: 'End-of-day reflection and gratitude',
    icon: '🌆',
    isBuiltIn: true,
    tags: ['reflection', 'gratitude'],
    properties: [
      {
        name: 'mood',
        type: 'select',
        value: 'neutral',
        options: ['great', 'good', 'neutral', 'low', 'difficult']
      },
      { name: 'energy', type: 'rating', value: 3 }
    ],
    content: `# Daily Reflection

## What went well today?

- 

## What could have gone better?

- 

## What am I grateful for?

1. 
2. 
3. 

## What did I learn?

`
  },
  {
    id: 'gratitude-journal',
    name: 'Gratitude Journal',
    description: 'Focus on what you appreciate',
    icon: '🙏',
    isBuiltIn: true,
    tags: ['gratitude'],
    properties: [],
    content: `# Gratitude

Today I am grateful for:

1. 
2. 
3. 
4. 
5. 

---

*One moment that made me smile:*

`
  },
  {
    id: 'weekly-review',
    name: 'Weekly Review',
    description: 'Reflect on your week and plan ahead',
    icon: '📅',
    isBuiltIn: true,
    tags: ['weekly', 'review', 'planning'],
    properties: [{ name: 'weekNumber', type: 'number', value: 0 }],
    content: `# Weekly Review

## Wins This Week

- 

## Challenges Faced

- 

## Lessons Learned

- 

## Next Week's Focus

1. 
2. 
3. 

## Energy & Wellbeing Check

How do I feel about this week overall?

`
  }
]

// ============================================================================
// Helpers
// ============================================================================

/**
 * Get the vault path, throwing if no vault is open.
 */
function getVaultPath(): string {
  const status = getStatus()
  if (!status.path) {
    throw new VaultError('No vault is currently open', VaultErrorCode.NOT_INITIALIZED)
  }
  return status.path
}

/**
 * Get the templates directory path.
 */
export function getTemplatesDir(): string {
  const vaultPath = getVaultPath()
  return path.join(getMemryDir(vaultPath), TEMPLATES_DIR)
}

/**
 * Ensure the templates directory exists and seed built-in templates.
 */
export async function ensureTemplatesDir(): Promise<void> {
  const templatesDir = getTemplatesDir()

  if (!existsSync(templatesDir)) {
    mkdirSync(templatesDir, { recursive: true })
  }

  // Seed built-in templates if they don't exist
  await seedBuiltInTemplates()
}

/**
 * Seed built-in templates to the templates directory.
 */
async function seedBuiltInTemplates(): Promise<void> {
  const templatesDir = getTemplatesDir()
  const now = new Date().toISOString()

  for (const template of BUILT_IN_TEMPLATES) {
    const filePath = path.join(templatesDir, `${template.id}.md`)

    // Only create if doesn't exist
    if (!existsSync(filePath)) {
      const fullTemplate: Template = {
        ...template,
        createdAt: now,
        modifiedAt: now
      }
      await writeTemplate(filePath, fullTemplate)
    }
  }
}

/**
 * Emit template event to all windows.
 */
function emitTemplateEvent(channel: string, payload: unknown): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send(channel, payload)
  })
}

/**
 * Parse a template file.
 */
function parseTemplate(content: string, filePath: string): Template {
  const { data, content: body } = matter(content)

  // Extract id from filename if not in frontmatter
  const id = data.id || path.basename(filePath, '.md')

  return {
    id,
    name: data.name || id,
    description: data.description,
    icon: data.icon || null,
    isBuiltIn: data.isBuiltIn === true,
    tags: Array.isArray(data.tags) ? data.tags : [],
    properties: Array.isArray(data.properties) ? data.properties : [],
    content: body.trim(),
    createdAt: data.createdAt || new Date().toISOString(),
    modifiedAt: data.modifiedAt || new Date().toISOString()
  }
}

/**
 * Serialize a template to file content.
 */
function serializeTemplate(template: Template): string {
  const frontmatter: Record<string, unknown> = {
    id: template.id,
    name: template.name,
    isBuiltIn: template.isBuiltIn,
    createdAt: template.createdAt,
    modifiedAt: template.modifiedAt
  }

  if (template.description) {
    frontmatter.description = template.description
  }

  if (template.icon) {
    frontmatter.icon = template.icon
  }

  if (template.tags.length > 0) {
    frontmatter.tags = template.tags
  }

  if (template.properties.length > 0) {
    frontmatter.properties = template.properties
  }

  return matter.stringify(template.content, frontmatter)
}

/**
 * Write a template to file.
 */
async function writeTemplate(filePath: string, template: Template): Promise<void> {
  const content = serializeTemplate(template)
  await fs.writeFile(filePath, content, 'utf-8')
}

/**
 * Get template file path by ID.
 */
function getTemplatePath(id: string): string {
  const templatesDir = getTemplatesDir()
  return path.join(templatesDir, `${id}.md`)
}

// ============================================================================
// CRUD Operations
// ============================================================================

/**
 * List all templates.
 */
export async function listTemplates(): Promise<TemplateListItem[]> {
  await ensureTemplatesDir()
  const templatesDir = getTemplatesDir()

  try {
    const files = await fs.readdir(templatesDir)
    const templates: TemplateListItem[] = []

    for (const file of files) {
      if (!file.endsWith('.md')) continue

      const filePath = path.join(templatesDir, file)
      try {
        const content = await fs.readFile(filePath, 'utf-8')
        const template = parseTemplate(content, filePath)
        templates.push({
          id: template.id,
          name: template.name,
          description: template.description,
          icon: template.icon,
          isBuiltIn: template.isBuiltIn
        })
      } catch {
        // Skip files that can't be parsed
        console.warn(`Failed to parse template: ${file}`)
      }
    }

    // Sort: built-in first, then by name
    templates.sort((a, b) => {
      if (a.isBuiltIn !== b.isBuiltIn) {
        return a.isBuiltIn ? -1 : 1
      }
      return a.name.localeCompare(b.name)
    })

    return templates
  } catch (error) {
    console.error('Failed to list templates:', error)
    return []
  }
}

/**
 * Get a template by ID.
 */
export async function getTemplate(id: string): Promise<Template | null> {
  await ensureTemplatesDir()
  const filePath = getTemplatePath(id)

  try {
    const content = await fs.readFile(filePath, 'utf-8')
    return parseTemplate(content, filePath)
  } catch {
    return null
  }
}

/**
 * Create a new template.
 */
export async function createTemplate(input: TemplateCreateInput): Promise<Template> {
  await ensureTemplatesDir()

  const id = generateNoteId()
  const now = new Date().toISOString()

  const template: Template = {
    id,
    name: input.name,
    description: input.description,
    icon: input.icon ?? null,
    isBuiltIn: false,
    tags: input.tags ?? [],
    properties: (input.properties ?? []) as TemplateProperty[],
    content: input.content ?? '',
    createdAt: now,
    modifiedAt: now
  }

  const filePath = getTemplatePath(id)
  await writeTemplate(filePath, template)

  // Emit event
  emitTemplateEvent(TemplatesChannels.events.CREATED, { template })

  return template
}

/**
 * Update an existing template.
 */
export async function updateTemplate(input: TemplateUpdateInput): Promise<Template> {
  const existing = await getTemplate(input.id)
  if (!existing) {
    throw new VaultError(`Template not found: ${input.id}`, VaultErrorCode.NOT_FOUND)
  }

  // Prevent modifying built-in templates
  if (existing.isBuiltIn) {
    throw new VaultError('Cannot modify built-in templates', VaultErrorCode.PERMISSION_DENIED)
  }

  const now = new Date().toISOString()

  const updated: Template = {
    ...existing,
    name: input.name ?? existing.name,
    description: input.description !== undefined ? input.description : existing.description,
    icon: input.icon !== undefined ? input.icon : existing.icon,
    tags: input.tags ?? existing.tags,
    properties:
      input.properties !== undefined
        ? (input.properties as TemplateProperty[])
        : existing.properties,
    content: input.content ?? existing.content,
    modifiedAt: now
  }

  const filePath = getTemplatePath(input.id)
  await writeTemplate(filePath, updated)

  // Emit event
  emitTemplateEvent(TemplatesChannels.events.UPDATED, { id: input.id, template: updated })

  return updated
}

/**
 * Delete a template.
 */
export async function deleteTemplate(id: string): Promise<void> {
  const existing = await getTemplate(id)
  if (!existing) {
    throw new VaultError(`Template not found: ${id}`, VaultErrorCode.NOT_FOUND)
  }

  // Prevent deleting built-in templates
  if (existing.isBuiltIn) {
    throw new VaultError('Cannot delete built-in templates', VaultErrorCode.PERMISSION_DENIED)
  }

  const filePath = getTemplatePath(id)
  await fs.unlink(filePath)

  // Emit event
  emitTemplateEvent(TemplatesChannels.events.DELETED, { id })
}

/**
 * Duplicate a template.
 */
export async function duplicateTemplate(id: string, newName: string): Promise<Template> {
  const existing = await getTemplate(id)
  if (!existing) {
    throw new VaultError(`Template not found: ${id}`, VaultErrorCode.NOT_FOUND)
  }

  // Create a new template based on the existing one
  return createTemplate({
    name: newName,
    description: existing.description,
    icon: existing.icon,
    tags: [...existing.tags],
    properties: existing.properties.map((p) => ({ ...p })),
    content: existing.content
  })
}

/**
 * Apply a template to create note content.
 * Replaces {{title}} placeholder with actual title.
 */
export function applyTemplate(
  template: Template,
  title: string
): {
  content: string
  tags: string[]
  properties: Record<string, unknown>
} {
  // Replace {{title}} placeholder
  const content = template.content.replace(/\{\{title\}\}/g, title)

  // Convert properties array to record
  const properties: Record<string, unknown> = {}
  for (const prop of template.properties) {
    properties[prop.name] = prop.value
  }

  return {
    content,
    tags: [...template.tags],
    properties
  }
}

import type { TemplateProperty, TemplateRecord, TemplatesService } from '@memry/app-core/service-types'
export type { TemplateProperty, TemplateRecord, CreateTemplateInput, UpdateTemplateInput, TemplatesService } from '@memry/app-core/service-types'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createId } from '@memry/app-core/ids'
import { parseMarkdownNote, writeMarkdownNote } from '@memry/app-core/markdown'
import { getMemryDir, safeFilename } from './paths.ts'

function templatesDir(vaultPath: string): string {
  return path.join(getMemryDir(vaultPath), 'templates')
}

function templatePath(vaultPath: string, id: string): string {
  return path.join(templatesDir(vaultPath), `${safeFilename(id)}.md`)
}

function toTags(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((tag) => String(tag).trim()).filter(Boolean)
}

function toProperties(value: unknown): TemplateProperty[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((property): property is Record<string, unknown> => {
      return typeof property === 'object' && property !== null
    })
    .map((property) => ({
      name: String(property.name ?? ''),
      type: String(property.type ?? 'text'),
      value: property.value,
      options: Array.isArray(property.options)
        ? property.options.map((option) => String(option))
        : undefined
    }))
    .filter((property) => property.name.trim())
}

async function readTemplate(filePath: string): Promise<TemplateRecord> {
  const raw = await fs.readFile(filePath, 'utf-8')
  const parsed = parseMarkdownNote(raw)
  const id = String(parsed.frontmatter.id ?? path.basename(filePath, '.md'))

  return {
    id,
    name: String(parsed.frontmatter.name ?? id),
    description:
      parsed.frontmatter.description === undefined
        ? undefined
        : String(parsed.frontmatter.description),
    icon: parsed.frontmatter.icon === undefined ? null : String(parsed.frontmatter.icon),
    isBuiltIn: parsed.frontmatter.isBuiltIn === true,
    tags: toTags(parsed.frontmatter.tags),
    properties: toProperties(parsed.frontmatter.properties),
    content: parsed.content,
    path: filePath,
    createdAt: String(parsed.frontmatter.createdAt ?? new Date().toISOString()),
    modifiedAt: String(parsed.frontmatter.modifiedAt ?? new Date().toISOString())
  }
}

async function writeTemplate(vaultPath: string, template: TemplateRecord): Promise<void> {
  const frontmatter: Record<string, unknown> = {
    id: template.id,
    name: template.name,
    isBuiltIn: template.isBuiltIn,
    createdAt: template.createdAt,
    modifiedAt: template.modifiedAt
  }

  if (template.description) frontmatter.description = template.description
  if (template.icon) frontmatter.icon = template.icon
  if (template.tags.length > 0) frontmatter.tags = template.tags
  if (template.properties.length > 0) frontmatter.properties = template.properties

  await fs.mkdir(templatesDir(vaultPath), { recursive: true })
  await fs.writeFile(
    templatePath(vaultPath, template.id),
    writeMarkdownNote(frontmatter, template.content),
    'utf-8'
  )
}

export function createTemplatesService(vaultPath: string): TemplatesService {
  return {
    async list() {
      await fs.mkdir(templatesDir(vaultPath), { recursive: true })
      const files = await fs.readdir(templatesDir(vaultPath))
      const templates = await Promise.all(
        files
          .filter((file) => file.endsWith('.md'))
          .map((file) => readTemplate(path.join(templatesDir(vaultPath), file)))
      )
      return templates.sort((a, b) => a.name.localeCompare(b.name))
    },

    async get(id) {
      try {
        return await readTemplate(templatePath(vaultPath, id))
      } catch {
        return null
      }
    },

    async create(input) {
      const name = input.name.trim()
      if (!name) throw new Error('Template name is required')

      const now = new Date().toISOString()
      const template: TemplateRecord = {
        id: createId('template'),
        name,
        description: input.description,
        icon: input.icon ?? null,
        isBuiltIn: false,
        tags: input.tags ?? [],
        properties: input.properties ?? [],
        content: input.content ?? '',
        path: '',
        createdAt: now,
        modifiedAt: now
      }
      template.path = templatePath(vaultPath, template.id)
      await writeTemplate(vaultPath, template)
      return template
    },

    async update(id, input) {
      const existing = await this.get(id)
      if (!existing) throw new Error(`Template not found: ${id}`)
      if (existing.isBuiltIn) throw new Error('Cannot update built-in templates')

      const updated: TemplateRecord = {
        ...existing,
        name: input.name ?? existing.name,
        description: input.description ?? existing.description,
        icon: input.icon !== undefined ? input.icon : existing.icon,
        tags: input.tags ?? existing.tags,
        properties: input.properties ?? existing.properties,
        content: input.content ?? existing.content,
        modifiedAt: new Date().toISOString()
      }
      await writeTemplate(vaultPath, updated)
      return updated
    },

    async duplicate(id, newName) {
      const existing = await this.get(id)
      if (!existing) throw new Error(`Template not found: ${id}`)
      return this.create({
        name: newName,
        description: existing.description,
        icon: existing.icon,
        tags: [...existing.tags],
        properties: existing.properties.map((property) => ({ ...property })),
        content: existing.content
      })
    },

    async delete(id) {
      const existing = await this.get(id)
      if (!existing) return false
      if (existing.isBuiltIn) throw new Error('Cannot delete built-in templates')
      await fs.rm(templatePath(vaultPath, id), { force: true })
      return true
    }
  }
}

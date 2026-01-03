import { describe, it, expect } from 'vitest'
import {
  TemplatePropertySchema,
  TemplateCreateSchema,
  TemplateUpdateSchema,
  TemplateDuplicateSchema,
  FolderConfigSchema,
  SetFolderConfigSchema
} from './templates-api'

describe('TemplatePropertySchema', () => {
  it('should validate text property', () => {
    const result = TemplatePropertySchema.safeParse({
      name: 'title',
      type: 'text',
      value: 'Default Title'
    })
    expect(result.success).toBe(true)
  })

  it('should validate number property', () => {
    const result = TemplatePropertySchema.safeParse({
      name: 'priority',
      type: 'number',
      value: 5
    })
    expect(result.success).toBe(true)
  })

  it('should validate checkbox property', () => {
    const result = TemplatePropertySchema.safeParse({
      name: 'completed',
      type: 'checkbox',
      value: false
    })
    expect(result.success).toBe(true)
  })

  it('should validate date property', () => {
    const result = TemplatePropertySchema.safeParse({
      name: 'due',
      type: 'date',
      value: '2026-01-15'
    })
    expect(result.success).toBe(true)
  })

  it('should validate select property with options', () => {
    const result = TemplatePropertySchema.safeParse({
      name: 'status',
      type: 'select',
      value: 'todo',
      options: ['todo', 'in-progress', 'done']
    })
    expect(result.success).toBe(true)
  })

  it('should validate multiselect property', () => {
    const result = TemplatePropertySchema.safeParse({
      name: 'tags',
      type: 'multiselect',
      value: ['design', 'frontend'],
      options: ['design', 'frontend', 'backend']
    })
    expect(result.success).toBe(true)
  })

  it('should validate url property', () => {
    const result = TemplatePropertySchema.safeParse({
      name: 'link',
      type: 'url',
      value: 'https://example.com'
    })
    expect(result.success).toBe(true)
  })

  it('should validate rating property', () => {
    const result = TemplatePropertySchema.safeParse({
      name: 'importance',
      type: 'rating',
      value: 4
    })
    expect(result.success).toBe(true)
  })

  it('should validate all property types', () => {
    const types = ['text', 'number', 'checkbox', 'date', 'select', 'multiselect', 'url', 'rating']
    types.forEach((type) => {
      const result = TemplatePropertySchema.safeParse({ name: 'prop', type, value: null })
      expect(result.success).toBe(true)
    })
  })

  it('should reject empty name', () => {
    const result = TemplatePropertySchema.safeParse({
      name: '',
      type: 'text',
      value: 'test'
    })
    expect(result.success).toBe(false)
  })

  it('should reject invalid type', () => {
    const result = TemplatePropertySchema.safeParse({
      name: 'prop',
      type: 'invalid',
      value: 'test'
    })
    expect(result.success).toBe(false)
  })
})

describe('TemplateCreateSchema', () => {
  it('should validate minimal input with defaults', () => {
    const result = TemplateCreateSchema.safeParse({ name: 'My Template' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.tags).toEqual([])
      expect(result.data.properties).toEqual([])
      expect(result.data.content).toBe('')
    }
  })

  it('should validate full input', () => {
    const result = TemplateCreateSchema.safeParse({
      name: 'Project Template',
      description: 'Template for project notes',
      icon: '📋',
      tags: ['project', 'active'],
      properties: [{ name: 'status', type: 'select', value: 'active', options: ['active', 'done'] }],
      content: '# Project Notes\n\nAdd your content here.'
    })
    expect(result.success).toBe(true)
  })

  it('should reject empty name', () => {
    const result = TemplateCreateSchema.safeParse({ name: '' })
    expect(result.success).toBe(false)
  })

  it('should reject name over 200 chars', () => {
    const result = TemplateCreateSchema.safeParse({ name: 'a'.repeat(201) })
    expect(result.success).toBe(false)
  })

  it('should accept name at 200 chars boundary', () => {
    const result = TemplateCreateSchema.safeParse({ name: 'a'.repeat(200) })
    expect(result.success).toBe(true)
  })

  it('should accept null icon', () => {
    const result = TemplateCreateSchema.safeParse({ name: 'Template', icon: null })
    expect(result.success).toBe(true)
  })
})

describe('TemplateUpdateSchema', () => {
  it('should validate minimal update (id only)', () => {
    const result = TemplateUpdateSchema.safeParse({ id: 'template-1' })
    expect(result.success).toBe(true)
  })

  it('should validate update with name', () => {
    const result = TemplateUpdateSchema.safeParse({
      id: 'template-1',
      name: 'Updated Name'
    })
    expect(result.success).toBe(true)
  })

  it('should validate full update', () => {
    const result = TemplateUpdateSchema.safeParse({
      id: 'template-1',
      name: 'Updated Template',
      description: 'Updated description',
      icon: '📝',
      tags: ['updated'],
      properties: [{ name: 'status', type: 'text', value: 'updated' }],
      content: '# Updated Content'
    })
    expect(result.success).toBe(true)
  })

  it('should reject empty id', () => {
    const result = TemplateUpdateSchema.safeParse({ id: '' })
    expect(result.success).toBe(false)
  })

  it('should reject missing id', () => {
    const result = TemplateUpdateSchema.safeParse({ name: 'Test' })
    expect(result.success).toBe(false)
  })

  it('should reject empty name if provided', () => {
    const result = TemplateUpdateSchema.safeParse({
      id: 'template-1',
      name: ''
    })
    expect(result.success).toBe(false)
  })

  it('should reject name over 200 chars', () => {
    const result = TemplateUpdateSchema.safeParse({
      id: 'template-1',
      name: 'a'.repeat(201)
    })
    expect(result.success).toBe(false)
  })
})

describe('TemplateDuplicateSchema', () => {
  it('should validate correct input', () => {
    const result = TemplateDuplicateSchema.safeParse({
      id: 'template-1',
      newName: 'Template Copy'
    })
    expect(result.success).toBe(true)
  })

  it('should reject empty id', () => {
    const result = TemplateDuplicateSchema.safeParse({
      id: '',
      newName: 'Copy'
    })
    expect(result.success).toBe(false)
  })

  it('should reject empty newName', () => {
    const result = TemplateDuplicateSchema.safeParse({
      id: 'template-1',
      newName: ''
    })
    expect(result.success).toBe(false)
  })

  it('should reject newName over 200 chars', () => {
    const result = TemplateDuplicateSchema.safeParse({
      id: 'template-1',
      newName: 'a'.repeat(201)
    })
    expect(result.success).toBe(false)
  })

  it('should accept newName at 200 chars boundary', () => {
    const result = TemplateDuplicateSchema.safeParse({
      id: 'template-1',
      newName: 'a'.repeat(200)
    })
    expect(result.success).toBe(true)
  })
})

describe('FolderConfigSchema', () => {
  it('should validate empty object with defaults', () => {
    const result = FolderConfigSchema.safeParse({})
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.inherit).toBe(true)
    }
  })

  it('should validate full config', () => {
    const result = FolderConfigSchema.safeParse({
      template: 'project-template',
      inherit: false
    })
    expect(result.success).toBe(true)
  })

  it('should validate with template only', () => {
    const result = FolderConfigSchema.safeParse({ template: 'default' })
    expect(result.success).toBe(true)
  })

  it('should validate with inherit only', () => {
    const result = FolderConfigSchema.safeParse({ inherit: true })
    expect(result.success).toBe(true)
  })
})

describe('SetFolderConfigSchema', () => {
  it('should validate correct input', () => {
    const result = SetFolderConfigSchema.safeParse({
      folderPath: 'projects',
      config: { template: 'project-template' }
    })
    expect(result.success).toBe(true)
  })

  it('should validate with empty config', () => {
    const result = SetFolderConfigSchema.safeParse({
      folderPath: 'notes',
      config: {}
    })
    expect(result.success).toBe(true)
  })

  it('should reject missing folderPath', () => {
    const result = SetFolderConfigSchema.safeParse({
      config: { template: 'default' }
    })
    expect(result.success).toBe(false)
  })

  it('should reject missing config', () => {
    const result = SetFolderConfigSchema.safeParse({
      folderPath: 'projects'
    })
    expect(result.success).toBe(false)
  })

  it('should validate nested folder paths', () => {
    const result = SetFolderConfigSchema.safeParse({
      folderPath: 'projects/2026/active',
      config: { template: 'project', inherit: true }
    })
    expect(result.success).toBe(true)
  })
})

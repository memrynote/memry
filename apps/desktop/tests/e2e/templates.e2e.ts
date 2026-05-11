import fs from 'fs'
import path from 'path'
import { test, expect } from './fixtures'
import { ready, uniqueLabel } from './utils/desktop-test-helpers'

test.describe('Templates E2E', () => {
  test('creates, updates, duplicates, deletes, and persists templates in the vault', async ({
    page,
    testVaultPath
  }) => {
    await ready(page)

    const templateName = uniqueLabel('Template')
    const updatedName = `${templateName} Updated`
    const copyName = `${templateName} Copy`

    const result = await page.evaluate(
      async ({ templateName, updatedName, copyName }) => {
        const api = window.api
        const created = await api.templates.create({
          name: templateName,
          description: 'Template coverage from Electron E2E',
          icon: 'T',
          tags: ['e2e-template'],
          properties: [
            {
              name: 'Stage',
              type: 'select',
              value: 'Draft',
              options: ['Draft', 'Final']
            }
          ],
          content: '# Template heading\n\nBody from E2E'
        })
        if (!created.success || !created.template) {
          throw new Error(created.error ?? 'template create failed')
        }

        const updated = await api.templates.update({
          id: created.template.id,
          name: updatedName,
          tags: ['e2e-template', 'updated'],
          content: '# Updated heading\n\nUpdated body from E2E'
        })
        if (!updated.success || !updated.template) {
          throw new Error(updated.error ?? 'template update failed')
        }

        const duplicate = await api.templates.duplicate(created.template.id, copyName)
        if (!duplicate.success || !duplicate.template) {
          throw new Error(duplicate.error ?? 'template duplicate failed')
        }

        const beforeDelete = await api.templates.list()
        await api.templates.delete(duplicate.template.id)
        await api.templates.delete(created.template.id)
        const afterDelete = await api.templates.list()

        return {
          createdId: created.template.id,
          duplicateId: duplicate.template.id,
          updated,
          beforeDelete,
          afterDelete
        }
      },
      { templateName, updatedName, copyName }
    )

    expect(result.updated.template).toMatchObject({
      id: result.createdId,
      name: updatedName,
      tags: ['e2e-template', 'updated'],
      content: '# Updated heading\n\nUpdated body from E2E'
    })
    expect(result.beforeDelete.templates.map((template) => template.name)).toEqual(
      expect.arrayContaining([updatedName, copyName])
    )
    expect(result.afterDelete.templates.map((template) => template.id)).not.toEqual(
      expect.arrayContaining([result.createdId, result.duplicateId])
    )

    const templatePath = path.join(testVaultPath, '.memry', 'templates', `${result.createdId}.md`)
    const duplicatePath = path.join(
      testVaultPath,
      '.memry',
      'templates',
      `${result.duplicateId}.md`
    )
    expect(fs.existsSync(templatePath)).toBe(false)
    expect(fs.existsSync(duplicatePath)).toBe(false)
  })
})

import { test, expect } from './fixtures/sync-auth-fixtures'
import {
  test as legacyTest,
  expect as legacyExpect,
  LEGACY_TEMPLATE_ID,
  LEGACY_TEMPLATE_NAME,
  LEGACY_TEMPLATE_BODY
} from './fixtures/legacy-template-fixtures'
import { goOffline, goOnline, syncBothAndWait, waitForSyncOnline } from './utils/network-control'
import type { Page } from '@playwright/test'

async function createTemplate(page: Page, name: string, content: string): Promise<string> {
  return page.evaluate(
    async ({ name, content }) => {
      const result = await window.api.templates.create({ name, content })
      if (!result.success || !result.template) throw new Error('template create failed')
      return result.template.id
    },
    { name, content }
  )
}

async function listTemplateNames(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const result = await window.api.templates.list()
    return result.templates.map((t) => t.name)
  })
}

async function getTemplateContent(page: Page, id: string): Promise<string | null> {
  return page.evaluate(async (templateId) => {
    const template = await window.api.templates.get(templateId)
    return template?.content ?? null
  }, id)
}

test.describe('Custom template sync', () => {
  test('T1: a template created on A appears on B', async ({
    pageA,
    pageB,
    bootstrappedSyncPair
  }) => {
    void bootstrappedSyncPair
    const name = `T1 Standup ${Date.now()}`

    const id = await createTemplate(pageA, name, '## Blockers')
    expect(await listTemplateNames(pageB)).not.toContain(name)

    await syncBothAndWait(pageA, pageB)

    expect(await listTemplateNames(pageB)).toContain(name)
    expect(await getTemplateContent(pageB, id)).toBe('## Blockers')
  })

  test('T2: an edit on A propagates to B', async ({ pageA, pageB, bootstrappedSyncPair }) => {
    void bootstrappedSyncPair
    const name = `T2 Standup ${Date.now()}`

    const id = await createTemplate(pageA, name, 'v1')
    await syncBothAndWait(pageA, pageB)

    await pageA.evaluate(async (templateId) => {
      await window.api.templates.update({ id: templateId, content: 'v2' })
    }, id)
    await syncBothAndWait(pageA, pageB)

    expect(await getTemplateContent(pageB, id)).toBe('v2')
  })

  test('T3: a delete on A tombstones on B', async ({ pageA, pageB, bootstrappedSyncPair }) => {
    void bootstrappedSyncPair
    const name = `T3 Standup ${Date.now()}`

    const id = await createTemplate(pageA, name, 'v1')
    await syncBothAndWait(pageA, pageB)
    expect(await listTemplateNames(pageB)).toContain(name)

    await pageA.evaluate(async (templateId) => {
      await window.api.templates.delete(templateId)
    }, id)
    await syncBothAndWait(pageA, pageB)

    expect(await listTemplateNames(pageB)).not.toContain(name)
    expect(await getTemplateContent(pageB, id)).toBeNull()
  })

  test('T4: concurrent offline edits converge by LWW without looping', async ({
    electronAppA,
    electronAppB,
    pageA,
    pageB,
    bootstrappedSyncPair
  }) => {
    void bootstrappedSyncPair
    const name = `T4 Standup ${Date.now()}`

    const id = await createTemplate(pageA, name, 'base')
    await syncBothAndWait(pageA, pageB)

    await goOffline(electronAppA, electronAppB)
    await pageA.evaluate(async (t) => {
      await window.api.templates.update({ id: t, content: 'from-A' })
    }, id)
    await pageB.evaluate(async (t) => {
      await window.api.templates.update({ id: t, content: 'from-B' })
    }, id)

    await goOnline(electronAppA, electronAppB)
    await Promise.all([waitForSyncOnline(pageA), waitForSyncOnline(pageB)])
    await syncBothAndWait(pageA, pageB)

    const contentA = await getTemplateContent(pageA, id)
    const contentB = await getTemplateContent(pageB, id)
    expect(contentA).toBe(contentB)
    expect(['from-A', 'from-B']).toContain(contentA)
  })

  test('T6: built-ins exist on both devices and never duplicate', async ({
    pageA,
    pageB,
    bootstrappedSyncPair
  }) => {
    void bootstrappedSyncPair
    await syncBothAndWait(pageA, pageB)

    for (const page of [pageA, pageB]) {
      const names = await listTemplateNames(page)
      const blanks = names.filter((n) => n === 'Blank Note')
      expect(blanks).toHaveLength(1)
    }
  })
})

legacyTest.describe('Legacy template migration', () => {
  legacyTest(
    'T5: a pre-sync template file on A is migrated and reaches B',
    async ({ pageA, pageB, bootstrappedSyncPair }) => {
      void bootstrappedSyncPair

      // A's vault had the file on disk before launch; openVault should have
      // imported it with clock NULL, and seedUnclocked should have pushed it.
      legacyExpect(await listTemplateNames(pageA)).toContain(LEGACY_TEMPLATE_NAME)

      await syncBothAndWait(pageA, pageB)

      legacyExpect(await listTemplateNames(pageB)).toContain(LEGACY_TEMPLATE_NAME)
      legacyExpect(await getTemplateContent(pageB, LEGACY_TEMPLATE_ID)).toBe(LEGACY_TEMPLATE_BODY)
    }
  )
})

// @ts-nocheck - E2E tests in development, follow canvas-cards.e2e.ts convention
/**
 * Project and filed-file cards on the spatial canvas (#2082).
 *
 * Both are placed through the Add card picker the way a user places them, and
 * both are asserted against the scene JSON the store holds: the card is a
 * rectangle carrying only `{ entityType, entityId }`, never the project's or
 * file's content. Rename, move and delete run through window.api so the card is
 * seen following the entity rather than a stale copy.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { test, expect, type Page } from './fixtures'
import { PNG_BYTES, ready, uniqueLabel } from './utils/desktop-test-helpers'

async function openVault(page: Page): Promise<void> {
  await page
    .locator('aside, [data-testid="sidebar"], [class*="sidebar"], nav')
    .first()
    .waitFor({ state: 'visible', timeout: 90_000 })
  await ready(page)
}

async function enableSpatialCanvas(page: Page): Promise<void> {
  const result = await page.evaluate(async () =>
    window.api.settings.setFeaturesSettings({ spatialCanvas: true })
  )
  if (!result?.success) throw new Error(result?.error ?? 'setFeaturesSettings failed')
  await page.reload()
  await openVault(page)
}

async function createCanvasFromSidebar(page: Page): Promise<string> {
  const header = page.getByRole('button', { name: /Canvases section/ })
  await expect(header).toBeVisible()
  await header.hover()
  await page.getByRole('button', { name: 'New canvas', exact: true }).click()
  await expect(page.locator('[data-canvas-editor]')).toBeVisible({ timeout: 20000 })
  await expect(page.locator('.excalidraw').first()).toBeVisible({ timeout: 20000 })
  const list = await page.evaluate(async () => window.api.canvas.list())
  return list.canvases[0].id
}

async function cardsIn(page: Page, canvasId: string) {
  const scene = await page.evaluate(
    async (id) => (await window.api.canvas.get(id))?.scene ?? '',
    canvasId
  )
  const parsed = scene ? JSON.parse(scene) : { elements: [] }
  return {
    scene,
    cards: (parsed.elements ?? [])
      .filter((e) => e.type === 'rectangle' && !e.isDeleted && e.customData?.entityId)
      .map((e) => e.customData)
  }
}

async function pick(page: Page, query: string, key: string): Promise<void> {
  await page.getByTestId('canvas-add-card').click()
  // Fill once and wait out the picker's 150ms debounce; refilling on every
  // poll would reset the query and race the debounce it waits on.
  await page.getByTestId('canvas-add-input').fill(query)
  await expect(page.getByTestId(`canvas-add-item-${key}`)).toBeVisible({ timeout: 15000 })
  await page.getByTestId(`canvas-add-item-${key}`).click()
}

test.describe('Spatial canvas — project and file cards (#2082)', () => {
  test.describe.configure({ timeout: 240_000 })

  test('a project card is found, placed, survives a restart, follows a rename, opens, and dangles on delete', async ({
    page
  }) => {
    await openVault(page)
    await enableSpatialCanvas(page)
    const canvasId = await createCanvasFromSidebar(page)

    const name = uniqueLabel('Canvas Project')
    const secret = `DESCRIPTION_${Date.now()}`
    const projectId = await page.evaluate(
      async ({ n, d }) => {
        const res = await window.api.tasks.createProject({ name: n, description: d })
        return res?.project?.id ?? ''
      },
      { n: name, d: secret }
    )
    expect(projectId).toBeTruthy()

    await pick(page, name, `project:${projectId}`)

    const card = page.locator(`[data-canvas-card-entity="project:${projectId}"]`)
    await expect(card).toContainText(name, { timeout: 20000 })
    await expect
      .poll(async () => (await cardsIn(page, canvasId)).cards, { timeout: 15000 })
      .toEqual([{ entityType: 'project', entityId: projectId }])
    expect((await cardsIn(page, canvasId)).scene).not.toContain(secret)

    await page.reload()
    await openVault(page)
    await expect(card).toContainText(name, { timeout: 20000 })

    const renamed = uniqueLabel('Renamed Project')
    await page.evaluate(async ({ id, n }) => window.api.tasks.updateProject({ id, name: n }), {
      id: projectId,
      n: renamed
    })
    await expect(card).toContainText(renamed, { timeout: 20000 })

    await card.getByRole('button', { name: 'Open in tab' }).click()
    await expect(page.getByRole('tab', { name: renamed })).toBeVisible({ timeout: 20000 })

    await page.evaluate(async (id) => window.api.tasks.deleteProject(id), projectId)
    await page
      .getByRole('tab', { name: /Canvas|Untitled canvas/ })
      .first()
      .click()
    await expect(card).toHaveAttribute('data-canvas-card-state', 'dangling', { timeout: 20000 })
    expect((await cardsIn(page, canvasId)).cards).toEqual([
      { entityType: 'project', entityId: projectId }
    ])
  })

  test('a filed image is found, previewed, follows rename and move, opens in the viewer, and dangles on delete', async ({
    page
  }) => {
    await openVault(page)
    await enableSpatialCanvas(page)
    const canvasId = await createCanvasFromSidebar(page)

    const importDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-e2e-canvas-file-'))
    const base = `canvasfile${Date.now()}`
    const source = path.join(importDir, `${base}.png`)
    fs.writeFileSync(source, Buffer.from(PNG_BYTES))

    try {
      const imported = await page.evaluate(
        async (p) => window.api.notes.importFiles([p], ''),
        source
      )
      expect(imported.success).toBe(true)

      const findImported = () =>
        page.evaluate(async (title) => {
          const list = await window.api.notes.list({ limit: 200 })
          return list.notes.find((n) => n.fileType === 'image' && n.title === title)?.id ?? ''
        }, base)
      await expect.poll(findImported, { timeout: 20000 }).not.toBe('')
      const fileId = await findImported()

      await pick(page, base, `file:${fileId}`)

      const card = page.locator(`[data-canvas-card-entity="file:${fileId}"]`)
      await expect(card).toContainText(base, { timeout: 20000 })
      await expect(card.locator('img')).toHaveAttribute('src', /^memry-file:\/\/local\//)
      await expect
        .poll(async () => (await cardsIn(page, canvasId)).cards, { timeout: 15000 })
        .toEqual([{ entityType: 'file', entityId: fileId }])

      const renamed = `${base}renamed`
      await page.evaluate(async ({ id, t }) => window.api.notes.rename(id, t), {
        id: fileId,
        t: renamed
      })
      await expect(card).toContainText(renamed, { timeout: 20000 })

      await page.evaluate(async () => window.api.notes.createFolder('Filed'))
      await page.evaluate(async ({ id }) => window.api.notes.move(id, 'Filed'), { id: fileId })
      await expect(card).toContainText('Filed', { timeout: 20000 })

      await card.getByRole('button', { name: 'Open in tab' }).click()
      await expect(page.getByRole('tab', { name: renamed })).toBeVisible({ timeout: 20000 })

      await page.evaluate(async (id) => window.api.notes.delete(id), fileId)
      await page
        .getByRole('tab', { name: /Canvas|Untitled canvas/ })
        .first()
        .click()
      await expect(card).toHaveAttribute('data-canvas-card-state', 'dangling', { timeout: 20000 })
      expect((await cardsIn(page, canvasId)).cards).toEqual([
        { entityType: 'file', entityId: fileId }
      ])
    } finally {
      fs.rmSync(importDir, { recursive: true, force: true })
    }
  })
})

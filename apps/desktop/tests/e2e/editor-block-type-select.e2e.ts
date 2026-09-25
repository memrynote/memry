import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { ready, uniqueLabel } from './utils/desktop-test-helpers'
import { SELECTORS } from './utils/electron-helpers'
import { createNoteWithBody } from './utils/note-sync-helpers'

interface BlockSummary {
  type: string
  level?: number
  text: string
}

async function blocks(page: Page): Promise<BlockSummary[]> {
  return page.evaluate(() => {
    const editor = (window as unknown as { __memryEditor?: any }).__memryEditor
    if (!editor) throw new Error('window.__memryEditor not exposed')
    return (editor.document as any[])
      .map((block) => ({
        type: block.type as string,
        ...(block.type === 'heading' ? { level: block.props.level as number } : {}),
        text: Array.isArray(block.content)
          ? block.content.map((item: any) => item?.text ?? '').join('')
          : ''
      }))
      .filter((block, index, all) => !(index === all.length - 1 && block.text === ''))
  })
}

/** Drag-select `text` inside the editor with the real mouse. */
async function dragSelect(page: Page, text: string, fromRatio = 0.2, toRatio = 0.7): Promise<void> {
  const target = page.locator(SELECTORS.noteEditor).getByText(text, { exact: true }).first()
  const box = await target.boundingBox()
  if (!box) throw new Error(`no box for ${text}`)
  const y = box.y + box.height / 2
  await page.mouse.move(box.x + box.width * fromRatio, y)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * toRatio, y, { steps: 8 })
  await page.mouse.up()
}

async function pickBlockType(page: Page, name: string): Promise<void> {
  const trigger = page.locator('.memry-format-toolbar-block-type-trigger button').first()
  await expect(trigger).toBeVisible({ timeout: 10_000 })
  await trigger.click()
  const option = page.getByRole('option', { name, exact: true })
  await expect(option).toBeVisible({ timeout: 5_000 })
  await option.click()
}

test.describe('Formatting toolbar block type select', () => {
  test.beforeEach(async ({ page }) => {
    await ready(page)
  })

  test('retypes the block holding a partial text selection', async ({ page }) => {
    await createNoteWithBody(
      page,
      uniqueLabel('Block type partial'),
      'Alpha line\nBeta line\nGamma line\nLast line'
    )
    await expect.poll(() => blocks(page)).toHaveLength(4)

    await dragSelect(page, 'Beta line')
    await pickBlockType(page, 'Heading 5')

    await expect(page.getByRole('option')).toHaveCount(0)
    await expect
      .poll(() => blocks(page))
      .toEqual([
        { type: 'paragraph', text: 'Alpha line' },
        { type: 'heading', level: 5, text: 'Beta line' },
        { type: 'paragraph', text: 'Gamma line' },
        { type: 'paragraph', text: 'Last line' }
      ])
  })

  test('retypes every block in a multi-line selection', async ({ page }) => {
    await createNoteWithBody(
      page,
      uniqueLabel('Block type multi'),
      'Alpha line\nBeta line\nGamma line\nLast line'
    )
    await expect.poll(() => blocks(page)).toHaveLength(4)

    const from = await page
      .locator(SELECTORS.noteEditor)
      .getByText('Alpha line', { exact: true })
      .boundingBox()
    const to = await page
      .locator(SELECTORS.noteEditor)
      .getByText('Beta line', { exact: true })
      .boundingBox()
    if (!from || !to) throw new Error('no boxes')
    await page.mouse.move(from.x + 4, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(to.x + to.width - 4, to.y + to.height / 2, { steps: 8 })
    await page.mouse.up()

    await pickBlockType(page, 'Heading 2')

    await expect
      .poll(() => blocks(page))
      .toEqual([
        { type: 'heading', level: 2, text: 'Alpha line' },
        { type: 'heading', level: 2, text: 'Beta line' },
        { type: 'paragraph', text: 'Gamma line' },
        { type: 'paragraph', text: 'Last line' }
      ])
  })
  test('Turn into from the block menu converts every marquee-selected text block', async ({
    page
  }) => {
    await createNoteWithBody(
      page,
      uniqueLabel('Turn into marquee'),
      'Alpha line\nBeta line\nLast line'
    )
    await expect.poll(() => blocks(page)).toHaveLength(3)
    await page.evaluate(() => {
      const editor = (window as unknown as { __memryEditor?: any }).__memryEditor
      editor.insertBlocks(
        [{ type: 'table', content: { type: 'tableContent', rows: [{ cells: ['a', 'b'] }] } }],
        editor.document[1].id,
        'after'
      )
    })
    await expect
      .poll(async () => (await blocks(page)).map((b) => b.type))
      .toEqual(['paragraph', 'paragraph', 'table', 'paragraph'])

    // Marquee from the margin beside Alpha down to the table.
    // Well clear of the side menu handle, which also sits in the margin.
    const zone = await page.locator('.marquee-zone').first().boundingBox()
    if (!zone) throw new Error('no marquee zone')
    const x = zone.x + 12
    const alpha = await page.locator('.bn-block[data-id]').nth(0).boundingBox()
    const table = await page.locator('.bn-block[data-id]').nth(2).boundingBox()
    if (!alpha || !table) throw new Error('no boxes')
    await page.mouse.move(x, alpha.y + 2)
    await page.mouse.down()
    await page.mouse.move(alpha.x + alpha.width / 2, table.y + table.height / 2, { steps: 14 })
    await page.mouse.up()
    await expect.poll(() => page.locator('.marquee-block-highlight').count()).toBe(3)

    await page.locator('.bn-block-content').nth(1).hover()
    const handle = page.locator('[data-test="dragHandle"]').first()
    await handle.waitFor({ state: 'visible', timeout: 5_000 })
    await handle.click()
    await expect.poll(() => page.locator('.marquee-block-highlight').count()).toBe(3)
    await page.getByRole('menuitem', { name: 'Turn into' }).hover()
    await page.getByRole('menuitem', { name: 'Heading 2' }).click()

    await expect
      .poll(async () => (await blocks(page)).map((b) => b.type))
      .toEqual(['heading', 'heading', 'table', 'paragraph'])
  })

  test('sticky toolbar retypes marquee-selected blocks, not the last line', async ({ page }) => {
    await page.evaluate(() => window.api.settings.setEditorSettings({ toolbarMode: 'sticky' }))
    try {
      await createNoteWithBody(page, uniqueLabel('Marquee toolbar'), 'One\nTwo\nThree\nLast line')
      await expect.poll(() => blocks(page)).toHaveLength(4)
      await page.evaluate(() => {
        const editor = (window as unknown as { __memryEditor?: any }).__memryEditor
        for (const block of (editor.document as any[]).slice(0, 3)) {
          editor.updateBlock(block.id, { type: 'bulletListItem' })
        }
      })
      await expect
        .poll(async () => (await blocks(page)).map((b) => b.type))
        .toEqual(['bulletListItem', 'bulletListItem', 'bulletListItem', 'paragraph'])

      const zone = await page.locator('.marquee-zone').first().boundingBox()
      const first = await page.locator('.bn-block[data-id]').nth(0).boundingBox()
      const third = await page.locator('.bn-block[data-id]').nth(2).boundingBox()
      if (!zone || !first || !third) throw new Error('no boxes')
      await page.mouse.move(zone.x + 12, first.y + 2)
      await page.mouse.down()
      await page.mouse.move(first.x + first.width / 2, third.y + third.height / 2, { steps: 14 })
      await page.mouse.up()
      await expect.poll(() => page.locator('.marquee-block-highlight').count()).toBe(3)

      await page.locator('[data-test="list-type-numbered"]').first().click()

      await expect
        .poll(async () => (await blocks(page)).map((b) => b.type))
        .toEqual(['numberedListItem', 'numberedListItem', 'numberedListItem', 'paragraph'])
    } finally {
      await page.evaluate(() => window.api.settings.setEditorSettings({ toolbarMode: 'floating' }))
    }
  })
})

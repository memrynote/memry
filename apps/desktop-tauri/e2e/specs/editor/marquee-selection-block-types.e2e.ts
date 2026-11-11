// Every block type the editor renders is marquee-selectable, ported from Electron's
// `marquee-selection-block-types.e2e.ts` (Step 14k, #3531). A `taskBlock` declares
// `content: 'none'`, and the old marquee went through BlockNote's TextSelection, which throws for
// such a block and cleared the highlight on release. The marquee now keeps its own block state and
// deletes through `editor.removeBlocks`.
//
// The task blocks here name task ids no task row holds: the tasks domain is not ported yet (Step
// 21, #3538), and the marquee reads the block, not the row. The Tab and Shift+Tab rows, which
// write a task's parent through `tasks.update`, wait for that step.
import { openNewNote, setBlocks } from '../../harness/editor'
import { blockCount, highlightCount, marqueeAcross } from '../../harness/marquee'
import { vaultOpen } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'

const TASK_BLOCK = '[data-content-type="taskBlock"]'

const label = (name: string): string => `${name} ${Date.now().toString(36)}`

const taskBlock = (title: string) => ({
  type: 'taskBlock',
  props: { taskId: `e2e-${title.replaceAll(' ', '-')}`, title, checked: false, parentTaskId: '' }
})

async function openWith(page: Page, name: string, blocks: unknown[]): Promise<number> {
  await vaultOpen(page)
  await openNewNote(page, label(name), 'seed')
  await setBlocks(page, blocks)
  await expect.poll(() => blockCount(page)).toBeGreaterThan(blocks.length - 1)
  // Task blocks settle their layout after they mount; a drag over a re-render highlights nothing.
  await page.waitForTimeout(500)
  return blockCount(page)
}

const fewer = async (page: Page, than: number): Promise<void> =>
  expect.poll(async () => (await blockCount(page)) < than).toBe(true)

test('a single task block highlights and Backspace deletes it', async ({ page }) => {
  await openWith(page, 'Marquee Single TaskBlock', [taskBlock('Single marquee task')])
  await expect(page.locator(TASK_BLOCK)).toHaveCount(1)

  await marqueeAcross(page, 0, 0)
  await expect(page.locator('.marquee-block-highlight')).toHaveCount(1)

  // Asserted on the task block, not the count: a document never goes empty, so removing its only
  // block leaves one empty paragraph.
  await page.keyboard.press('Backspace')
  await expect(page.locator(TASK_BLOCK)).toHaveCount(0)
})

test('adjacent task blocks keep their highlight and Backspace deletes them', async ({ page }) => {
  const start = await openWith(page, 'Marquee Multi TaskBlocks', [
    taskBlock('Multi task 1'),
    taskBlock('Multi task 2'),
    taskBlock('Multi task 3')
  ])
  await expect(page.locator(TASK_BLOCK)).toHaveCount(3)

  await marqueeAcross(page, 0, 2)
  expect(await highlightCount(page)).toBeGreaterThanOrEqual(3)

  await page.keyboard.press('Backspace')
  await fewer(page, start)
})

test('a paragraph, task block, heading and paragraph are one selection', async ({ page }) => {
  const start = await openWith(page, 'Marquee Mixed', [
    { type: 'paragraph', content: 'Para before' },
    taskBlock('Mixed marquee task'),
    { type: 'heading', props: { level: 1 }, content: 'Heading in middle' },
    { type: 'paragraph', content: 'Para after' }
  ])
  await expect(page.locator(TASK_BLOCK)).toHaveCount(1)

  await marqueeAcross(page, 0, 3)
  expect(await highlightCount(page)).toBeGreaterThanOrEqual(4)

  await page.keyboard.press('Backspace')
  await fewer(page, start)
})

test('callout blocks keep their highlight after release', async ({ page }) => {
  await openWith(page, 'Marquee Callout', [
    { type: 'callout', props: { type: 'info' }, content: 'Callout one' },
    { type: 'callout', props: { type: 'warning' }, content: 'Callout two' }
  ])
  await expect(page.locator('[data-content-type="callout"]')).toHaveCount(2)

  await marqueeAcross(page, 0, 1)
  expect(await highlightCount(page)).toBeGreaterThanOrEqual(2)
})

test('a code block highlights and Backspace removes it', async ({ page }) => {
  const start = await openWith(page, 'Marquee Code', [
    { type: 'codeBlock', props: { language: 'javascript' }, content: 'const foo = 1' }
  ])
  await expect(page.locator('[data-content-type="codeBlock"]')).toHaveCount(1)

  await marqueeAcross(page, 0, 0)
  expect(await highlightCount(page)).toBeGreaterThanOrEqual(1)

  await page.keyboard.press('Backspace')
  await expect(page.locator('[data-content-type="codeBlock"]')).toHaveCount(0)
  expect(await blockCount(page)).toBeLessThanOrEqual(start)
})

test('bullet items keep their highlight and Backspace deletes them', async ({ page }) => {
  const start = await openWith(page, 'Marquee Bullets', [
    { type: 'bulletListItem', content: 'Bullet one' },
    { type: 'bulletListItem', content: 'Bullet two' },
    { type: 'bulletListItem', content: 'Bullet three' }
  ])
  await expect(page.locator('[data-content-type="bulletListItem"]')).toHaveCount(3)

  await marqueeAcross(page, 0, 2)
  expect(await highlightCount(page)).toBeGreaterThanOrEqual(3)

  await page.keyboard.press('Backspace')
  await fewer(page, start)
})

test('the highlight is still there 200 ms after release', async ({ page }) => {
  await openWith(page, 'Marquee Persistence', [
    { type: 'paragraph', content: 'Para before' },
    taskBlock('Persistence task'),
    { type: 'paragraph', content: 'Para after' }
  ])

  await marqueeAcross(page, 0, 2)
  // Past the release's finalize tick: the stable state, not the mid-drag one.
  await page.waitForTimeout(200)
  expect(await highlightCount(page)).toBeGreaterThanOrEqual(3)
})

// These write a task's parent through `tasks.update` and read it back with `tasks.get`, which Step
// 21 (#3538) ports. Electron's rows 8 to 12.
test.skip('Tab indents marquee-selected task blocks under the previous task', async () => {})
test.skip('Tab on a task block and a bullet indents each through its own path', async () => {})
test.skip('Shift+Tab lifts marquee-selected subtasks back to the top level', async () => {})
test.skip('Tab on an already nested subtask writes nothing', async () => {})
test.skip('Tab on a first task with no task before it writes nothing', async () => {})

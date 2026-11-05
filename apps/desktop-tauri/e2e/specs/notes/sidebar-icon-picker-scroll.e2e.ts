// The sidebar icon picker survives a sidebar scroll (#1986), ported from Electron's
// `sidebar-icon-picker-scroll.e2e.ts` (Step 13q-4, #3530).
//
// Past 100 tree items the sidebar swaps to the virtualized tree, which mounts only the visible
// rows plus an overscan. The picker is a Radix Popover rendered inside its row, so a scroll that
// pushed the row out of the virtual window unmounted the panel with it. The row whose picker is
// open is now pinned into the virtual range, and Radix re-anchors the panel.
import type { Locator } from '../../harness/pw-compat/locator'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'
import { vaultStatus } from '../../harness/vault-commands'
import { pollUntil } from '../../harness/wait'

const PICKER = 'Emoji and icon picker' // notes:menus.emoji.aria
// The virtualized tree takes over at 100 items (VIRTUALIZATION_THRESHOLD).
const SEEDED_NOTES = 130

async function ready(page: Page): Promise<void> {
  expect(await pollUntil(async () => (await vaultStatus(page)).isOpen, { timeoutMs: 30_000 })).toBe(
    true
  )
}

/** Creates the notes one after another through `notes_create`, as the renderer does. */
async function seedNotes(page: Page, count: number): Promise<void> {
  await page.evaluate(async (total: number) => {
    for (let i = 0; i < total; i++) {
      await window.__TAURI__.core.invoke('notes_create', {
        input: { title: `Picker Scroll ${String(i).padStart(3, '0')}`, content: 'seed' }
      })
    }
  }, count)
}

async function expandCollections(page: Page): Promise<void> {
  const header = page.locator('#section-header-collections')
  await expect(header).toBeVisible({ timeout: 30_000 })
  if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click()
  await expect(header).toHaveAttribute('aria-expanded', 'true')
  // The section opens through a 100 ms transition inside an overflow-hidden box. The driver
  // scrolls a row it clicks into view, which scrolls that box mid-transition; the box springs
  // back when the transition ends and the click lands on the row above.
  await expect
    .poll(() =>
      page
        .locator('#section-content-collections > div')
        .evaluate(
          (box: HTMLElement) => box.clientHeight > 0 && box.scrollHeight <= box.clientHeight
        )
    )
    .toBe(true)
}

const SCROLLER = 'data-e2e-sidebar-scroller'

/** Marks every ancestor of `trigger` that can scroll vertically; returns how many. */
function markScrollers(trigger: Locator): Promise<number> {
  return trigger.evaluate((start: Element, attribute: string) => {
    let marked = 0
    for (let element = start.parentElement; element; element = element.parentElement) {
      const { overflowY } = getComputedStyle(element)
      if (overflowY === 'auto' || overflowY === 'scroll') {
        element.setAttribute(attribute, '')
        marked += 1
      }
    }
    return marked
  }, SCROLLER)
}

/** The summed offset of the marked scrollers: it grows whichever of them the wheel scrolls. */
const scrolled = (page: Page): Promise<number> =>
  page.evaluate(
    (attribute: string) =>
      [...document.querySelectorAll(`[${attribute}]`)].reduce(
        (sum, element) => sum + element.scrollTop,
        0
      ),
    SCROLLER
  )

/** What a failed scroll leaves to read: each marked scroller, and what is under the wheel. */
const scrollReport = (page: Page, x: number, y: number): Promise<unknown> =>
  page.evaluate(
    ({ attribute, px, py }: { attribute: string; px: number; py: number }) => ({
      scrollers: [...document.querySelectorAll(`[${attribute}]`)].map((element) => ({
        className: element.className.slice(0, 80),
        scrollTop: element.scrollTop,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        overflowY: getComputedStyle(element).overflowY
      })),
      underWheel: document.elementFromPoint(px, py)?.outerHTML.slice(0, 160) ?? null
    }),
    { attribute: SCROLLER, px: x, py: y }
  )

test('the sidebar icon picker stays open when the virtualized tree scrolls under it', async ({
  page
}) => {
  test.slow()
  await ready(page)
  await seedNotes(page, SEEDED_NOTES)
  await expandCollections(page)
  // The virtualized tree nests a row's treeitem under its positioned wrapper; the plain tree puts
  // both on one element. The swap remounts every row, an open picker with it.
  await expect(page.locator('[data-tree-node-id="folder-notes"] > [role="treeitem"]')).toBeVisible({
    timeout: 30_000
  })

  const triggers = page.getByRole('button', { name: 'Set Icon' })
  await triggers.first().waitFor({ state: 'visible', timeout: 30_000 })
  const trigger = triggers.nth(5)
  await trigger.click()

  const picker = page.getByRole('dialog', { name: PICKER })
  await expect(picker).toBeVisible({ timeout: 10_000 })
  expect(await markScrollers(trigger)).toBeGreaterThan(0)
  const before = await scrolled(page)

  // Scroll over the sidebar, not over the panel: a stray trackpad nudge.
  const box = await trigger.boundingBox()
  expect(box).not.toBeNull()
  const [x, y] = [box!.x + 5, box!.y + 5]
  await page.mouse.move(x, y)
  await page.mouse.wheel(0, 800)
  // The wheel scrolls smoothly: wait until it has come to rest, past where it started.
  let last = before
  const rest = await pollUntil(
    async () => {
      const now = await scrolled(page)
      const settled = now > before && now === last
      last = now
      return settled
    },
    { intervalMs: 250 }
  )
  if (!rest) {
    throw new Error(`the sidebar did not scroll: ${JSON.stringify(await scrollReport(page, x, y))}`)
  }

  // The regression: the row left the virtual window and took the panel with it.
  await expect(picker).toBeVisible()
  await expect(picker.getByRole('button', { name: 'Icons' })).toBeVisible()
})

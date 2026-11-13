// A block handle dragged out of a portal window onto the host note moves the portal, not the
// source block (`portal-window-drag-out.ts`, #4406). The window is an editor on the SOURCE note,
// so BlockNote's own cross-editor move deleted the block from the source and pasted it into the
// host. WebDriver cannot start a native HTML5 drag in a webview, so the spec dispatches the drag
// events the handle and the host receive, as `editor-command-flows.e2e.ts` does for drops.
import { noteBody } from '../../harness/editor'
import { NOTE_EDITOR, createNote, openFromSidebar, vaultOpen } from '../../harness/notes'
import { test, expect } from '../../harness/test'

const TIMEOUT = { timeout: 30_000 }
const FENCE = '```memry-portal'

test('dragging a block out of a portal window moves the portal and keeps the source block', async ({
  page
}) => {
  test.setTimeout(180_000)
  await vaultOpen(page)
  const stamp = Date.now().toString(36)
  const anchor = `dg${stamp}`
  const moved = `Dragged ${stamp} block`
  const source = await createNote(page, {
    title: `Drag source ${stamp}`,
    content: `- Intro ${stamp}\n- ${moved} ^${anchor}\n`
  })
  const top = `Host top ${stamp}`
  const definition = JSON.stringify({ v: 1, note: source.id, blocks: [anchor] }, null, 2)
  const host = await createNote(page, {
    title: `Drag host ${stamp}`,
    content: `${top}\n\n${FENCE}\n${definition}\n\`\`\`\n\nHost bottom ${stamp}\n`
  })
  await openFromSidebar(page, host)
  await page.locator(NOTE_EDITOR).first().waitFor({ state: 'visible', timeout: 15_000 })

  // The window's side menu shows its drag handle while the pointer is over the block.
  const windowBlock = page
    .locator('.portal-window .bn-block-content')
    .filter({ hasText: moved })
    .first()
  await windowBlock.waitFor({ state: 'visible', timeout: 30_000 })
  await windowBlock.hover()
  const handle = page.locator('.portal-window .bn-side-menu [draggable="true"]').first()
  await handle.waitFor({ state: 'visible', timeout: 15_000 })

  const dropped = await page.evaluate((topText: string) => {
    const grip = document.querySelector('.portal-window .bn-side-menu [draggable="true"]')
    const target = Array.from(document.querySelectorAll('.bn-block-content')).find(
      (el) => el.closest('.portal-window') === null && (el.textContent ?? '').includes(topText)
    )
    if (!grip || !target) return false
    const rect = target.getBoundingClientRect()
    const at = { clientX: rect.left + 8, clientY: rect.top + 2 }
    const data = new DataTransfer()
    const drag = (el: Element, type: string, init: DragEventInit = {}): void => {
      el.dispatchEvent(
        new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data, ...init })
      )
    }
    const start = grip.getBoundingClientRect()
    drag(grip, 'dragstart', { clientX: start.left + 2, clientY: start.top + 2 })
    drag(target, 'dragenter', at)
    drag(target, 'dragover', at)
    drag(target, 'drop', at)
    drag(grip.isConnected ? grip : document.body, 'dragend', at)
    return true
  }, top)
  expect(dropped).toBe(true)

  // The host now opens on the portal, above the line it was dropped on.
  await expect
    .poll(async () => {
      const body = (await noteBody(page, host.id)) ?? ''
      return body.indexOf(FENCE) >= 0 && body.indexOf(FENCE) < body.indexOf(top)
    }, TIMEOUT)
    .toBe(true)
  const hostBody = (await noteBody(page, host.id)) ?? ''
  expect(hostBody.split(FENCE)).toHaveLength(2)
  expect(hostBody).not.toContain(moved)
  // The source still holds the block, anchor and all, so every portal onto it still resolves.
  expect(await noteBody(page, source.id)).toContain(`${moved} ^${anchor}`)
})

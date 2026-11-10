// An HTML embed in a note runs third-party script, so its frame must not get Tauri's IPC globals on
// any OS (#4150). The main window keeps them and its invoke still answers.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createNote, openFromSidebar, vaultOpen } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'

const EMBED_REPLY = '__embedGlobalsReply'

async function mainWindowInvokes(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const count = await window.__TAURI__.core.invoke('notes_get_local_only_count')
    return `${typeof window.__TAURI_INTERNALS__} ${typeof count}`
  })
}

test('an HTML embed in a note has no Tauri IPC globals, and the main window keeps them', async ({
  page,
  testVaultPath
}) => {
  await vaultOpen(page)
  expect(await mainWindowInvokes(page)).toBe('object number')

  const folder = join(testVaultPath, 'attachments', 'n1')
  mkdirSync(folder, { recursive: true })
  writeFileSync(
    join(folder, 'globals-embed.html'),
    `<!doctype html><p>embed</p><script>
parent.postMessage(JSON.stringify({ globals: [typeof window.__TAURI_INTERNALS__, typeof window.__TAURI__] }), '*')
</script>`
  )
  await page.evaluate((key) => {
    window.addEventListener('message', (event) => {
      const embed = document.querySelector<HTMLIFrameElement>('[data-testid="html-embed"]')
      if (
        embed &&
        event.source === embed.contentWindow &&
        typeof event.data === 'string' &&
        event.data.includes('"globals"')
      ) {
        ;(window as unknown as Record<string, string>)[key] = event.data
      }
    })
  }, EMBED_REPLY)

  const note = await createNote(page, {
    title: `Embed globals ${Date.now().toString(36)}`,
    content:
      'Above\n\n<!-- file:{"url":"../attachments/n1/globals-embed.html","name":"globals-embed.html","size":10,"mimeType":"text/html"} -->\n\nBelow',
    folder: 'notes'
  })
  await openFromSidebar(page, note)
  await expect(page.locator('[data-testid="html-embed"]')).toHaveCount(1)

  const readReply = (): Promise<string | undefined> =>
    page.evaluate(
      (key) => (window as unknown as Record<string, string | undefined>)[key],
      EMBED_REPLY
    )
  await expect.poll(readReply, { timeout: 15_000 }).toBeTruthy()
  const reply = JSON.parse((await readReply()) ?? '{}') as { globals: string[] }
  console.log(`embed-ipc-globals on ${process.platform}: ${JSON.stringify(reply)}`)
  expect(reply.globals).toEqual(['undefined', 'undefined'])

  expect(await mainWindowInvokes(page)).toBe('object number')
})

// Files dropped from the OS (inv09 #1: the webview's own drop handler is off, so a drop reaches the
// page as DOM `File` objects with no path). The page streams each file into the shell's staging
// area, the import gets the copies' paths, and the copies are deleted when the import settles.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { appReady } from '../../harness/app-ready'
import { invokeTest } from '../../harness/invoke-test'
import { invoke } from '../../harness/vault-commands'
import { test, expect } from '../../harness/test'

interface AppInfo {
  appDataDir: string
}

declare global {
  interface Window {
    __dropImport?: { calls: Array<{ paths: string[]; folder: string }>; finish: () => void }
  }
}

const CHUNK = 4 * 1024 * 1024

test('a dropped file is staged with its bytes for the import, then deleted', async ({
  app,
  page
}) => {
  await appReady(page)
  const staging = join((await invokeTest<AppInfo>(app, 'e2e_app_info')).appDataDir, 'drop-staging')

  // The import is not ported yet: stand in for it, and keep it pending until the spec has read the
  // staged copies, because they are deleted the moment it settles.
  await page.evaluate(() => {
    const state: NonNullable<Window['__dropImport']> = { calls: [], finish: () => undefined }
    window.__dropImport = state
    // The page's api with one namespace replaced; everything else reads through to the real one.
    window.api = Object.assign(Object.create(window.api), {
      notes: {
        importFiles: (paths: string[], folder: string) =>
          new Promise((resolve) => {
            state.calls.push({ paths, folder })
            state.finish = () => resolve({ imported: paths.length, failed: 0, errors: [] })
          })
      }
    })
  })

  const note = 'Hello from the OS\n'.repeat(10)
  await page.evaluate(
    ({ text }) => {
      const zone = document.querySelector('[data-file-drop-folder=""]')
      if (!zone) throw new Error('the sidebar drop zone is missing')
      const transfer = new DataTransfer()
      transfer.items.add(new File([text], 'dropped note.md', { type: 'text/markdown' }))
      transfer.items.add(new File([new Uint8Array(3 * 1024 * 1024 + 17).fill(65)], 'scan.pdf'))
      transfer.items.add(new File(['MZ'], 'tool.exe'))
      for (const type of ['dragover', 'drop']) {
        zone.dispatchEvent(
          new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer })
        )
      }
    },
    { text: note }
  )

  await expect
    .poll(() => page.evaluate(() => window.__dropImport?.calls.length ?? 0), { timeout: 15_000 })
    .toBe(1)
  const call = await page.evaluate(() => window.__dropImport?.calls[0])
  // The unsupported file never leaves the page; the others keep their names and bytes.
  expect(call?.folder).toBe('')
  expect(call?.paths.length).toBe(2)
  const [notePath = '', pdfPath = ''] = call?.paths ?? []
  expect(notePath.startsWith(staging)).toBe(true)
  expect(notePath.endsWith('dropped note.md')).toBe(true)
  expect(readFileSync(notePath, 'utf8')).toBe(note)
  expect(pdfPath.endsWith('scan.pdf')).toBe(true)
  expect(statSync(pdfPath).size).toBe(3 * 1024 * 1024 + 17)
  expect(readFileSync(pdfPath).every((byte) => byte === 65)).toBe(true)

  await page.evaluate(() => window.__dropImport?.finish())
  await expect.poll(() => existsSync(notePath) || existsSync(pdfPath)).toBe(false)
})

test('a 120 MB file stages through the binary commands byte for byte, bounded in the page', async ({
  app,
  page
}) => {
  await appReady(page)
  const staging = join((await invokeTest<AppInfo>(app, 'e2e_app_info')).appDataDir, 'drop-staging')
  const total = 120 * 1024 * 1024

  const result = await page.evaluate(
    async ({ chunkBytes, size }) => {
      const invokeRaw = window.__TAURI__.core.invoke
      // `performance.memory` exists on Chromium (WebView2) only.
      const heap = () =>
        (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize
      const chunk = new Uint8Array(chunkBytes)
      for (let i = 0; i < chunk.length; i++) chunk[i] = (i * 31 + 7) & 255
      const before = heap()
      const started = performance.now()
      const id = (await invokeRaw('drop_stage_begin', { name: 'big.bin', size })) as string
      for (let offset = 0; offset < size; offset += chunkBytes) {
        const part = chunk.subarray(0, Math.min(chunkBytes, size - offset))
        await invokeRaw('drop_stage_chunk', part, {
          headers: { 'x-memry-meta': JSON.stringify({ id, offset }) }
        })
      }
      const path = (await invokeRaw('drop_stage_finish', { id })) as string
      const after = heap()
      return {
        id,
        path,
        ms: performance.now() - started,
        growth: before !== undefined && after !== undefined ? after - before : null
      }
    },
    { chunkBytes: CHUNK, size: total }
  )

  expect(result.path.startsWith(staging)).toBe(true)
  expect(statSync(result.path).size).toBe(total)
  const expected = createHash('sha256')
  const pattern = Buffer.alloc(CHUNK)
  for (let i = 0; i < CHUNK; i++) pattern[i] = (i * 31 + 7) & 255
  for (let offset = 0; offset < total; offset += CHUNK) {
    expected.update(pattern.subarray(0, Math.min(CHUNK, total - offset)))
  }
  const actual = createHash('sha256').update(readFileSync(result.path)).digest('hex')
  expect(actual).toBe(expected.digest('hex'))
  if (result.growth !== null) expect(result.growth).toBeLessThan(32 * 1024 * 1024)
  // Reported, not asserted: a debug build on a hosted runner is not the bench machine.
  console.log(
    `drop staging: ${total / 1024 / 1024} MB in ${Math.round(result.ms)} ms (${Math.round(
      total / 1024 / 1024 / (result.ms / 1000)
    )} MB/s)`
  )

  await invoke(page, 'drop_stage_release', { ids: [result.id] })
  expect(existsSync(result.path)).toBe(false)
})

test('the staging commands refuse an oversize file and a chunk out of order', async ({ page }) => {
  await appReady(page)
  const outcome = await page.evaluate(async () => {
    const invokeRaw = window.__TAURI__.core.invoke
    const code = (promise: Promise<unknown>) =>
      promise.then(
        () => 'accepted',
        (error: unknown) =>
          typeof error === 'object' && error !== null && 'code' in error
            ? String(error.code)
            : 'rejected'
      )
    const tooLarge = await code(
      invokeRaw('drop_stage_begin', { name: 'huge.bin', size: 2 * 1024 * 1024 * 1024 + 1 })
    )
    const id = (await invokeRaw('drop_stage_begin', { name: 'a.md', size: 8 })) as string
    const chunk = (offset: number) =>
      code(
        invokeRaw('drop_stage_chunk', new Uint8Array(4), {
          headers: { 'x-memry-meta': JSON.stringify({ id, offset }) }
        })
      )
    const skipped = await chunk(4)
    const first = await chunk(0)
    const unfinished = await code(invokeRaw('drop_stage_finish', { id }))
    await invokeRaw('drop_stage_release', { ids: [id] })
    const released = await chunk(4)
    return { tooLarge, skipped, first, unfinished, released }
  })

  expect(outcome).toEqual({
    tooLarge: 'drop_too_large',
    skipped: 'drop_out_of_order',
    first: 'accepted',
    unfinished: 'drop_incomplete',
    released: 'drop_unknown'
  })
})

// Files dropped from the OS (inv09 #1: the webview's own drop handler is off, so a drop reaches the
// page as DOM `File` objects with no path; WebKitGTK gives it no file at all). The page streams
// each file into the shell's staging area, or the shell copies the files of the OS drag it
// recorded; the import (`notes_import_files`, Step 32h1) copies them into the vault, and the copies
// are deleted when the import settles.
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { appReady } from '../../harness/app-ready'
import { invokeTest } from '../../harness/invoke-test'
import { invoke } from '../../harness/vault-commands'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'

interface AppInfo {
  appDataDir: string
}

const CHUNK = 4 * 1024 * 1024

/** The vault-relative paths of the vault's files, outside `.memry`. */
function vaultFiles(vault: string): string[] {
  return readdirSync(vault, { recursive: true, encoding: 'utf8' })
    .map((path) => path.split('\\').join('/'))
    .filter((path) => !path.startsWith('.memry'))
}

/** The one vault file named `name`, once the import has copied it. */
async function landed(vault: string, name: string): Promise<string> {
  await expect
    .poll(() => vaultFiles(vault).filter((path) => path.split('/').pop() === name).length, {
      timeout: 15_000
    })
    .toBe(1)
  const path = vaultFiles(vault).find((file) => file.split('/').pop() === name) ?? ''
  return join(vault, path)
}

/**
 * Drops on the sidebar's root zone what WebKitGTK hands the page for an OS file drag: a URI list
 * that reads empty, HTML, and no `File` objects. The event carries a stand-in `DataTransfer`, so
 * every engine sees exactly that form.
 */
async function dropHiddenFileList(page: Page): Promise<void> {
  await page.evaluate(() => {
    const zone = document.querySelector('[data-file-drop-folder=""]')
    if (!zone) throw new Error('the sidebar drop zone is missing')
    const transfer = {
      types: ['text/uri-list', 'text/html'],
      files: [],
      items: [],
      dropEffect: 'none',
      getData: (type: string) => (type === 'text/html' ? '<a href="#">file</a>' : '')
    }
    for (const type of ['dragover', 'drop']) {
      const event = new DragEvent(type, { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'dataTransfer', { value: transfer })
      zone.dispatchEvent(event)
    }
  })
}

test('a dropped file is staged and imported into the vault with its bytes, then deleted', async ({
  app,
  page,
  testVaultPath
}) => {
  await appReady(page)
  const staging = join((await invokeTest<AppInfo>(app, 'e2e_app_info')).appDataDir, 'drop-staging')

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

  // The unsupported file never leaves the page; the others keep their names and bytes.
  expect(readFileSync(await landed(testVaultPath, 'dropped note.md'), 'utf8')).toBe(note)
  const pdf = readFileSync(await landed(testVaultPath, 'scan.pdf'))
  expect(pdf.length).toBe(3 * 1024 * 1024 + 17)
  expect(pdf.every((byte) => byte === 65)).toBe(true)
  expect(vaultFiles(testVaultPath).some((path) => path.endsWith('tool.exe'))).toBe(false)
  await expect.poll(() => readdirSync(staging).length).toBe(0)
})

test('a WebKitGTK file drop is staged from the OS drag the shell recorded and imported', async ({
  app,
  page,
  testVaultPath
}) => {
  await appReady(page)
  const staging = join((await invokeTest<AppInfo>(app, 'e2e_app_info')).appDataDir, 'drop-staging')
  const outside = mkdtempSync(join(tmpdir(), 'memry-os-drag-'))
  const note = join(outside, 'from the file manager.md')
  const tool = join(outside, 'tool.exe')
  writeFileSync(note, 'dropped on the window\n')
  writeFileSync(tool, 'MZ')

  // What the GTK hooks record for a drag from a file manager dropped on the window; the page
  // reads none of it.
  const uris = [pathToFileURL(note).href, pathToFileURL(tool).href]
  await invokeTest(app, 'e2e_os_drag', { uris, dropped: true })
  await dropHiddenFileList(page)

  // The unsupported file is never copied; the note is, with its name and bytes.
  const copy = await landed(testVaultPath, 'from the file manager.md')
  expect(readFileSync(copy, 'utf8')).toBe('dropped on the window\n')
  expect(vaultFiles(testVaultPath).some((path) => path.endsWith('tool.exe'))).toBe(false)
  await expect.poll(() => readdirSync(staging).length).toBe(0)
  // A copy: the dropped file stays where it was.
  expect(existsSync(note)).toBe(true)
  rmSync(outside, { recursive: true, force: true })
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
  const bytes = readFileSync(result.path)
  expect(bytes.length).toBe(total)
  const expected = createHash('sha256')
  const pattern = Buffer.alloc(CHUNK)
  for (let i = 0; i < CHUNK; i++) pattern[i] = (i * 31 + 7) & 255
  for (let offset = 0; offset < total; offset += CHUNK) {
    expected.update(pattern.subarray(0, Math.min(CHUNK, total - offset)))
  }
  const actual = createHash('sha256').update(bytes).digest('hex')
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

test('the staging commands refuse an oversize file, a chunk out of order and files not dropped', async ({
  app,
  page
}) => {
  await appReady(page)
  const outside = mkdtempSync(join(tmpdir(), 'memry-os-drag-'))
  const dropped = pathToFileURL(join(outside, 'dropped.md')).href
  const secret = pathToFileURL(join(outside, 'secret.md')).href
  writeFileSync(join(outside, 'dropped.md'), 'a')
  writeFileSync(join(outside, 'secret.md'), 'b')
  // A drag that only crossed the window: nothing may be read or staged from it.
  await invokeTest(app, 'e2e_os_drag', { uris: [dropped], dropped: false })
  const hovered = await page.evaluate(
    async (uris) => {
      const invokeRaw = window.__TAURI__.core.invoke
      const code = (promise: Promise<unknown>) =>
        promise.then(
          () => 'accepted',
          (error: unknown) =>
            typeof error === 'object' && error !== null && 'code' in error
              ? String(error.code)
              : 'rejected'
        )
      return {
        read: await code(invokeRaw('drop_os_drag_uris')),
        stage: await code(invokeRaw('drop_stage_os_files', { uris }))
      }
    },
    [dropped]
  )
  expect(hovered).toEqual({ read: 'drop_not_dropped', stage: 'drop_not_dropped' })

  await invokeTest(app, 'e2e_os_drag', { uris: [dropped], dropped: true })
  const outcome = await page.evaluate(
    async ({ notDropped }) => {
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
      // The page names a file the OS drag did not carry, next to one it did.
      const outsideDrag = await code(invokeRaw('drop_stage_os_files', { uris: notDropped }))
      return { tooLarge, skipped, first, unfinished, released, outsideDrag }
    },
    { notDropped: [dropped, secret] }
  )

  expect(outcome).toEqual({
    tooLarge: 'drop_too_large',
    skipped: 'drop_out_of_order',
    first: 'accepted',
    unfinished: 'drop_incomplete',
    released: 'drop_unknown',
    outsideDrag: 'drop_not_dropped'
  })
  rmSync(outside, { recursive: true, force: true })
})

test('the import refuses a file that was neither dropped nor picked, before reading it', async ({
  page,
  testVaultPath
}) => {
  await appReady(page)
  const outside = mkdtempSync(join(tmpdir(), 'memry-import-'))
  const secret = join(outside, 'id_rsa')
  writeFileSync(secret, 'secret')

  const code = await page.evaluate(
    (path) =>
      window.__TAURI__.core.invoke('notes_import_files', { input: { sourcePaths: [path] } }).then(
        () => 'accepted',
        (error: unknown) =>
          typeof error === 'object' && error !== null && 'code' in error
            ? String(error.code)
            : 'rejected'
      ),
    secret
  )

  expect(code).toBe('import_path_refused')
  expect(vaultFiles(testVaultPath).some((path) => path.endsWith('id_rsa'))).toBe(false)
  rmSync(outside, { recursive: true, force: true })
})

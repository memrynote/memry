// The custom icon library in the running app (Step 13o, #3530), called from the page the way the
// picker's `services/custom-icons-service.ts` calls it: an upload as the raw request body, a link,
// the list that rebuilds missing files, rename and delete. The picker itself is reached from note,
// folder and tag rows, which Step 13f and later slices port; the `sidebar-icon-picker-*` specs
// move over with those rows.
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'

import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'
import { invoke, vaultStatus } from '../../harness/vault-commands'
import { pollUntil } from '../../harness/wait'

interface Icon {
  id: string
  name: string
  ext: string
  path: string
  createdAt: string
}

type Outcome = { icon: Icon } | { error: string }

/** An RGB PNG of `width` x `height`. */
function png(width: number, height: number): Buffer {
  const chunk = (kind: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(4)
    head.writeUInt32BE(data.length)
    const typed = Buffer.concat([Buffer.from(kind, 'latin1'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(typed))
    return Buffer.concat([head, typed, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  const rows = Buffer.alloc((width * 3 + 1) * height, 0x5a)
  for (let y = 0; y < height; y++) rows[y * (width * 3 + 1)] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const size = (file: Buffer): [number, number] => [file.readUInt32BE(16), file.readUInt32BE(20)]

async function ready(page: Page): Promise<void> {
  expect(await pollUntil(async () => (await vaultStatus(page)).isOpen, { timeoutMs: 30_000 })).toBe(
    true
  )
}

/** `custom_icons_add` with the bytes as the raw body, as `customIconsService.add` sends it. */
function add(page: Page, bytes: Buffer, name: string, ext: string): Promise<Outcome> {
  return page.evaluate(
    ({ body, meta }: { body: number[]; meta: string }) =>
      window.__TAURI__.core
        .invoke('custom_icons_add', new Uint8Array(body), {
          headers: { 'x-memry-meta': meta }
        })
        .then(
          (icon): Outcome => ({ icon: icon as Icon }),
          (error: unknown): Outcome => ({
            error:
              typeof error === 'object' && error !== null && 'message' in error
                ? String(error.message)
                : String(error)
          })
        ),
    { body: [...bytes], meta: JSON.stringify({ name, ext }) }
  )
}

function stored(outcome: Outcome): Icon {
  if ('error' in outcome) throw new Error(outcome.error)
  return outcome.icon
}

test('an uploaded image is stored as a 128 px PNG in the vault and announced', async ({
  page,
  testVaultPath
}) => {
  await ready(page)
  await page.evaluate(() => {
    const seen: string[] = []
    ;(window as unknown as { __iconEvents: string[] }).__iconEvents = seen
    return (
      window as unknown as {
        __TAURI__: {
          event: {
            listen(name: string, cb: (e: { payload: { id: string } }) => void): Promise<unknown>
          }
        }
      }
    ).__TAURI__.event
      .listen('custom-icons-updated-event', (event) => seen.push(event.payload.id))
      .then(() => true)
  })

  const icon = stored(await add(page, png(300, 150), 'Wide', 'png'))

  expect(icon.name).toBe('Wide')
  expect(icon.ext).toBe('png')
  expect(realpathSync(icon.path)).toBe(
    join(realpathSync(testVaultPath), '.memry', 'icons', `${icon.id}.png`)
  )
  expect(size(readFileSync(icon.path))).toEqual([128, 64])
  expect((await invoke<Icon[]>(page, 'custom_icons_list')).map((i) => i.id)).toEqual([icon.id])
  const announced = await pollUntil(
    async () =>
      (
        await page.evaluate(() => (window as unknown as { __iconEvents: string[] }).__iconEvents)
      ).includes(icon.id),
    { timeoutMs: 10_000 }
  )
  expect(announced).toBe(true)
})

test('a link is downloaded once, and an SVG with nothing usable is refused', async ({ page }) => {
  await ready(page)
  const image = png(64, 64)
  let requests = 0
  const server = createServer((_request, response) => {
    requests += 1
    response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': image.length })
    response.end(image)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const { port } = server.address() as AddressInfo
    const icon = await invoke<Icon>(page, 'custom_icons_add_from_url', {
      url: `http://127.0.0.1:${port}/assets/star.png`,
      name: null
    })
    expect(icon.name).toBe('star')
    expect(size(readFileSync(icon.path))).toEqual([64, 64])
    expect(requests).toBe(1)
  } finally {
    server.close()
  }

  const refused = await add(page, Buffer.from('<html><body>a page</body></html>'), 'Page', 'svg')
  expect(refused).toEqual({
    error: 'That image could not be read. Try a PNG, JPG, GIF, WEBP or SVG file.'
  })
  expect((await invoke<Icon[]>(page, 'custom_icons_list')).map((i) => i.name)).toEqual(['star'])
})

test('the list rebuilds a deleted file; rename keeps it and delete removes it once', async ({
  page,
  testVaultPath
}) => {
  await ready(page)
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle r="4"/></svg>'
  )
  const icon = stored(await add(page, svg, 'Dot', 'svg'))
  const bytes = readFileSync(icon.path)
  rmSync(join(testVaultPath, '.memry', 'icons'), { recursive: true })

  expect(await invoke<Icon[]>(page, 'custom_icons_list')).toEqual([icon])
  expect(readFileSync(icon.path)).toEqual(bytes)

  const renamed = await invoke<Icon>(page, 'custom_icons_rename', { id: icon.id, name: 'Circle' })
  expect(renamed).toEqual({ ...icon, name: 'Circle' })

  expect(await invoke<boolean>(page, 'custom_icons_delete', { id: icon.id })).toBe(true)
  expect(existsSync(icon.path)).toBe(false)
  expect(await invoke<boolean>(page, 'custom_icons_delete', { id: icon.id })).toBe(false)
  expect(await invoke<Icon[]>(page, 'custom_icons_list')).toEqual([])
})

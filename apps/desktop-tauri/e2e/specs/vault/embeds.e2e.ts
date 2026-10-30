// Obsidian image embeds in the running app (Step 12f-3b, #3529): `vault_resolve_embeds`, which
// the renderer's markdown parse calls, finds an embed's file in the open vault. Given the note's
// path it answers relative to the note, which is what a save then writes into the file; without
// one, a `memry-file` URL. An embed that names no file is left out.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { appReady } from '../../harness/app-ready'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'

const resolveEmbeds = (
  page: Page,
  refs: string[],
  notePath: string | null
): Promise<Record<string, string>> =>
  page.evaluate(
    (args) =>
      window.__TAURI_INTERNALS__.invoke('vault_resolve_embeds', args) as Promise<
        Record<string, string>
      >,
    { refs, notePath }
  )

test('an embed resolves relative to its note, and to a file URL without one', async ({
  page,
  testVaultPath
}) => {
  mkdirSync(join(testVaultPath, 'notes'), { recursive: true })
  writeFileSync(join(testVaultPath, 'notes', 'embed-photo.png'), 'not an image')
  await appReady(page)

  expect(await resolveEmbeds(page, ['embed-photo.png', 'missing.png'], 'notes/sub/n.md')).toEqual({
    'embed-photo.png': '../embed-photo.png'
  })
  const preview = await resolveEmbeds(page, ['embed-photo.png'], null)
  expect(preview['embed-photo.png']).toMatch(/^memry-file:\/\/local\/.+\/notes\/embed-photo\.png$/)
})

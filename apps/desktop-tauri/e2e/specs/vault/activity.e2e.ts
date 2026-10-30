// The vault activity log in the running app (Step 12f-3a, #3529): what the watcher finds in the
// vault folder is listed under Settings > Vault & Data and is in `.memry/activity.jsonl`, which
// "Show log file" reveals.
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { invokeTest } from '../../harness/invoke-test'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'
import { pollUntil } from '../../harness/wait'

interface NoteFile {
  path: string
  contentHash: string | null
}

async function settled(
  app: Parameters<typeof invokeTest>[0],
  found: (files: NoteFile[]) => boolean
): Promise<void> {
  const files = () => invokeTest<NoteFile[]>(app, 'e2e_vault_note_files')
  expect(await pollUntil(async () => found(await files()), { timeoutMs: 20_000 })).toBe(true)
}

async function openVaultSettings(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => typeof window.api?.settings), { timeout: 30_000 })
    .toBe('object')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Vault & Data', exact: true }).click()
}

test('a file Memry does not open is listed as skipped and reaches the log file', async ({
  app,
  page,
  testVaultPath
}) => {
  writeFileSync(join(testVaultPath, 'activity-photo.heic'), 'not an image')
  await openVaultSettings(page)
  await expect(page.getByText('Skipped activity-photo.heic')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('Something went wrong')).toHaveCount(0)

  const log = join(testVaultPath, '.memry', 'activity.jsonl')
  await page.getByText('Show log file', { exact: true }).click()
  expect(
    await pollUntil(
      async () => (await invokeTest<string[]>(app, 'e2e_revealed_paths')).includes(log),
      { timeoutMs: 10_000 }
    )
  ).toBe(true)
  expect(
    await pollUntil(() => readFileSync(log, 'utf8').includes('"path":"activity-photo.heic"'), {
      timeoutMs: 10_000
    })
  ).toBe(true)
})

// A note's file deleted outside deletes the note (Step 13d, #3530), which is listed as removed.
test('a note file added, renamed and deleted in the vault folder is listed', async ({
  app,
  page,
  testVaultPath
}) => {
  const [first, moved] = ['notes/activity-a.md', 'notes/activity-b.md']
  writeFileSync(join(testVaultPath, first), 'activity body\n')
  await settled(app, (files) => files.some((f) => f.path === first && f.contentHash !== null))
  renameSync(join(testVaultPath, first), join(testVaultPath, moved))
  await settled(app, (files) => files.some((f) => f.path === moved))
  rmSync(join(testVaultPath, moved))
  await settled(app, (files) => !files.some((f) => f.path === moved))

  await openVaultSettings(page)
  await expect(page.getByText(`Added ${first}`)).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText(`Renamed ${first} to ${moved}`)).toBeVisible()
  await expect(page.getByText(`Removed ${moved}`)).toBeVisible()
})

// Learned property types and Settings' property usage (#4413, Electron 2b3a512960). Notes an
// Obsidian vault holds carry properties no definition names: the index learns their types and
// writes them into `.memry/properties.md`, so after a restart Settings > Tags & Properties still
// lists them with the number of notes that use each.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Page } from '../../harness/pw-compat/page'
import { restart } from '../../harness/tauri-lifecycle'
import { test, expect } from '../../harness/test'
import { vaultStatus } from '../../harness/vault-commands'
import { pollUntil } from '../../harness/wait'

const BOOKS: Record<string, string> = {
  'notes/Dune.md': '---\nshelfpages: 412\nshelfgenre: fiction\n---\nA desert planet.\n',
  'notes/Walden.md': '---\nshelfpages: 352\nshelfgenre: essay\n---\nA cabin by a pond.\n',
  'notes/Ficciones.md': '---\nshelfpages: 174\n---\nLabyrinths.\n'
}

async function vaultOpen(page: Page): Promise<void> {
  expect(await pollUntil(async () => (await vaultStatus(page)).isOpen, { timeoutMs: 30_000 })).toBe(
    true
  )
}

function propertiesFile(vault: string): string {
  try {
    return readFileSync(join(vault, '.memry', 'properties.md'), 'utf8')
  } catch {
    return ''
  }
}

const learned = (vault: string) => {
  const file = propertiesFile(vault)
  return (
    file.includes('  shelfpages:\n    type: number\n') &&
    file.includes('  shelfgenre:\n    type: text\n')
  )
}

/** The text of the Settings row that names `name`: its name, type and note count. */
function rowText(page: Page, name: string): Promise<string | null> {
  return page.evaluate((wanted: string) => {
    const label = [...document.querySelectorAll('span')].find((s) => s.textContent === wanted)
    return label?.closest('.group')?.textContent ?? null
  }, name)
}

test('learned property types survive a restart and Settings lists them with their notes', async ({
  app,
  page,
  testVaultPath
}) => {
  await vaultOpen(page)
  for (const [rel, text] of Object.entries(BOOKS)) {
    writeFileSync(join(testVaultPath, rel), text)
  }
  expect(await pollUntil(async () => learned(testVaultPath), { timeoutMs: 30_000 })).toBe(true)

  await restart(app)
  await vaultOpen(page)
  expect(learned(testVaultPath)).toBe(true)

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Tags & Properties', exact: true }).click()
  await expect
    .poll(() => rowText(page, 'shelfpages'), { timeout: 30_000 })
    .toBe('shelfpagesNumber3 notes')
  await expect
    .poll(() => rowText(page, 'shelfgenre'), { timeout: 30_000 })
    .toBe('shelfgenreText2 notes')
})

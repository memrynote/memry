// The Obsidian open-as-copy (`apps/desktop/src/main/vault/obsidian-vault-copy.ts`) as a user
// reaches it: the picker's "Open folder as vault" button, its folder dialog, then the prompt.
// The dialog queue answers both (`OpenFolder` the folder, `Choose` the button index); no
// native dialog opens.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { TauriApp } from '../../harness/tauri-lifecycle'
import { invokeTest } from '../../harness/invoke-test'
import type { Page } from '../../harness/pw-compat/page'
import { removeDir } from '../../harness/remove-dir'
import { test, expect } from '../../harness/test'
import { invoke, vaultStatus } from '../../harness/vault-commands'

test.use({ extraEnv: { MEMRY_FORCE_VAULT_PICKER: '1' } })

const CREATE_COPY = '0'
const OPEN_ORIGINAL = '1'
const CANCEL = '2'

const TASKS = '- [ ] #task Renew passport 📅 2026-11-01\n'

const real = (path: string): string => realpathSync(path)

/** An Obsidian vault Memry never opened, in a fresh parent folder the caller removes. */
function obsidianVault(): { parent: string; vault: string } {
  const parent = mkdtempSync(join(tmpdir(), 'memry-e2e-obsidian-'))
  const vault = join(parent, 'My Vault')
  const files: Record<string, string> = {
    'Tasks.md': TASKS,
    '.obsidian/app.json': '{}',
    '.trash/old.md': 'deleted in Obsidian\n',
    '.git/HEAD': 'ref: refs/heads/main\n'
  }
  for (const [relative, text] of Object.entries(files)) {
    mkdirSync(dirname(join(vault, relative)), { recursive: true })
    writeFileSync(join(vault, relative), text)
  }
  return { parent, vault }
}

/** Windows will not delete a vault whose databases the app still has open. */
async function closeVault(page: Page): Promise<void> {
  await invoke(page, 'vault_close').catch((error: unknown) => {
    console.warn('vault_close before cleanup failed', error)
  })
}

/** Picks `vault` in the folder dialog of "Open folder as vault" and answers the prompt with `button`. */
async function openFolderAsVault(
  app: TauriApp,
  page: Page,
  vault: string,
  button: string
): Promise<void> {
  await invokeTest(app, 'e2e_dialog_queue_push', { kind: 'OpenFolder', paths: [vault] })
  await invokeTest(app, 'e2e_dialog_queue_push', { kind: 'Choose', paths: [button] })
  await page.getByText('Open folder as vault').click()
}

/** The open vault's real path, once one is open. */
async function openedVault(page: Page): Promise<string> {
  await expect.poll(async () => (await vaultStatus(page)).isOpen, { timeout: 30_000 }).toBe(true)
  return real((await vaultStatus(page)).path as string)
}

test('Create copy opens a copy beside the vault, and the next open of the vault opens that copy', async ({
  app,
  page
}) => {
  const { parent, vault } = obsidianVault()
  const copy = join(parent, 'My Vault-memrynote')
  try {
    await expect(page.getByText('Open folder as vault')).toBeVisible({ timeout: 30_000 })
    await openFolderAsVault(app, page, vault, CREATE_COPY)
    expect(await openedVault(page)).toBe(real(copy))
    expect(readFileSync(join(copy, 'Tasks.md'), 'utf8')).toBe(TASKS)
    for (const leftOut of ['.obsidian', '.trash', '.git']) {
      expect(existsSync(join(copy, leftOut))).toBe(false)
    }
    // The original was only read: no vault was opened in it.
    expect(existsSync(join(vault, '.memry'))).toBe(false)
    expect(readdirSync(parent).toSorted()).toEqual(['My Vault', 'My Vault-memrynote'])

    await invoke(page, 'vault_close')
    await expect(page.getByText('Open folder as vault')).toBeVisible({ timeout: 30_000 })
    await openFolderAsVault(app, page, vault, CREATE_COPY)
    expect(await openedVault(page)).toBe(real(copy))
    expect(readdirSync(parent).toSorted()).toEqual(['My Vault', 'My Vault-memrynote'])
  } finally {
    await closeVault(page)
    removeDir(parent)
  }
})

test('Cancel opens nothing, and Open original opens the vault in place', async ({ app, page }) => {
  const { parent, vault } = obsidianVault()
  try {
    await expect(page.getByText('Open folder as vault')).toBeVisible({ timeout: 30_000 })
    await openFolderAsVault(app, page, vault, CANCEL)
    await expect(page.getByRole('alert')).toHaveText('No folder selected', { timeout: 30_000 })
    expect((await vaultStatus(page)).isOpen).toBe(false)
    expect(existsSync(join(vault, '.memry'))).toBe(false)

    await openFolderAsVault(app, page, vault, OPEN_ORIGINAL)
    expect(await openedVault(page)).toBe(real(vault))
    expect(existsSync(join(vault, '.memry'))).toBe(true)
    expect(readdirSync(parent)).toEqual(['My Vault'])
  } finally {
    await closeVault(page)
    removeDir(parent)
  }
})

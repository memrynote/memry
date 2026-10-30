// The Obsidian open-as-copy (`apps/desktop/src/main/vault/obsidian-vault-copy.ts`) through
// `vault_select`, the picker's command. The prompt's three buttons are answered through the
// dialog queue (`Choose`, the button index); no native dialog opens.
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

import { invokeTest } from '../../harness/invoke-test'
import type { Page } from '../../harness/pw-compat/page'
import { removeDir } from '../../harness/remove-dir'
import { test, expect } from '../../harness/test'
import { invoke, type SelectResponse, vaultStatus } from '../../harness/vault-commands'

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

test('Create copy opens a copy beside the vault, and the next open of the vault opens that copy', async ({
  app,
  page
}) => {
  const { parent, vault } = obsidianVault()
  const copy = join(parent, 'My Vault-memrynote')
  try {
    await invokeTest(app, 'e2e_dialog_queue_push', { kind: 'Choose', paths: [CREATE_COPY] })
    const opened = await invoke<SelectResponse>(page, 'vault_select', { path: vault })
    expect(opened.success).toBe(true)
    expect(real(opened.vault?.path as string)).toBe(real(copy))
    expect(real((await vaultStatus(page)).path as string)).toBe(real(copy))
    expect(readFileSync(join(copy, 'Tasks.md'), 'utf8')).toBe(TASKS)
    for (const leftOut of ['.obsidian', '.trash', '.git']) {
      expect(existsSync(join(copy, leftOut))).toBe(false)
    }
    // The original was only read: no vault was opened in it.
    expect(existsSync(join(vault, '.memry'))).toBe(false)
    expect(readdirSync(parent).toSorted()).toEqual(['My Vault', 'My Vault-memrynote'])

    await invokeTest(app, 'e2e_dialog_queue_push', { kind: 'Choose', paths: [CREATE_COPY] })
    const again = await invoke<SelectResponse>(page, 'vault_select', { path: vault })
    expect(again.success).toBe(true)
    expect(real(again.vault?.path as string)).toBe(real(copy))
    expect(readdirSync(parent).toSorted()).toEqual(['My Vault', 'My Vault-memrynote'])
  } finally {
    await closeVault(page)
    removeDir(parent)
  }
})

test('Open original opens the vault in place, and Cancel opens nothing', async ({
  app,
  page,
  testVaultPath
}) => {
  const { parent, vault } = obsidianVault()
  try {
    await invokeTest(app, 'e2e_dialog_queue_push', { kind: 'Choose', paths: [CANCEL] })
    const cancelled = await invoke<SelectResponse>(page, 'vault_select', { path: vault })
    expect(cancelled).toMatchObject({ success: false, error: 'No folder selected' })
    expect(real((await vaultStatus(page)).path as string)).toBe(real(testVaultPath))
    expect(existsSync(join(vault, '.memry'))).toBe(false)

    await invokeTest(app, 'e2e_dialog_queue_push', { kind: 'Choose', paths: [OPEN_ORIGINAL] })
    const original = await invoke<SelectResponse>(page, 'vault_select', { path: vault })
    expect(original.success).toBe(true)
    expect(real(original.vault?.path as string)).toBe(real(vault))
    expect(existsSync(join(vault, '.memry'))).toBe(true)
    expect(readdirSync(parent)).toEqual(['My Vault'])
  } finally {
    await closeVault(page)
    removeDir(parent)
  }
})

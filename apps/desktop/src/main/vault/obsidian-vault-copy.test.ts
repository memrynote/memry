/**
 * Opening an Obsidian vault Memry has never opened offers a copy, so the
 * original folder is never written. Real folders on disk; only the native
 * dialog (answered by button index) and the translator are stand-ins.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const showMessageBox = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({ dialog: { showMessageBox } }))
vi.mock('../lib/main-i18n', () => ({
  getMainI18n: () => ({ getFixedT: () => (key: string) => key })
}))

import { resolveObsidianVaultOpen } from './obsidian-vault-copy'

const CREATE_COPY = 0
const OPEN_ORIGINAL = 1
const CANCEL = 2

const VAULT_FILES: Record<string, string> = {
  'Tasks.md': '- [ ] #task Renew passport 📅 2026-11-01\n',
  'Daily Notes/2026-10-20.md': '# 2026-10-20\n',
  'attachments/photo.png': 'png bytes',
  '.obsidian/app.json': '{}',
  '.obsidian/plugins/obsidian-tasks-plugin/data.json': '{"globalFilter":"#task"}',
  '.trash/old.md': 'deleted in Obsidian',
  '.git/HEAD': 'ref: refs/heads/main\n'
}

const OLD = new Date('2024-03-01T09:00:00Z')

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-vault-copy-'))
  showMessageBox.mockReset()
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function writeTree(dir: string, files: Record<string, string>): void {
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(dir, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
    fs.utimesSync(file, OLD, OLD)
  }
}

function obsidianVault(): string {
  const vault = path.join(root, 'My Vault')
  writeTree(vault, VAULT_FILES)
  return vault
}

/** Every file under `dir`, dot folders included, with its bytes and modified time. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const file = path.join(entry.parentPath, entry.name)
    out[path.relative(dir, file)] = `${fs.readFileSync(file, 'utf8')}@${fs.statSync(file).mtimeMs}`
  }
  return out
}

function answer(button: number): void {
  showMessageBox.mockResolvedValue({ response: button, checkboxChecked: false })
}

describe('resolveObsidianVaultOpen', () => {
  it('copies the vault beside itself and opens the copy, leaving the original as it was', async () => {
    const vault = obsidianVault()
    const before = snapshot(vault)
    answer(CREATE_COPY)

    const opened = await resolveObsidianVaultOpen(vault)

    const copy = path.join(root, 'My Vault-memrynote')
    expect(opened).toBe(copy)
    expect(snapshot(vault)).toEqual(before)
    // Notes and attachments come along with their dates. Obsidian's config,
    // trash and git history stay with the original.
    expect(snapshot(copy)).toEqual({
      'Tasks.md': before['Tasks.md'],
      [path.join('Daily Notes', '2026-10-20.md')]:
        before[path.join('Daily Notes', '2026-10-20.md')],
      [path.join('attachments', 'photo.png')]: before[path.join('attachments', 'photo.png')]
    })
    expect(fs.readdirSync(root).toSorted()).toEqual(['My Vault', 'My Vault-memrynote'])
  })

  it.each([
    ['opens the original in place', OPEN_ORIGINAL, true],
    ['opens nothing when cancelled', CANCEL, false]
  ])('%s without copying anything', async (_name, button, opensOriginal) => {
    const vault = obsidianVault()
    const before = snapshot(vault)
    answer(button)

    const opened = await resolveObsidianVaultOpen(vault)

    expect(opened).toBe(opensOriginal ? vault : null)
    expect(snapshot(vault)).toEqual(before)
    expect(fs.readdirSync(root)).toEqual(['My Vault'])
  })

  it.each([
    ['a folder Obsidian never opened', { 'Note.md': 'hello\n' }],
    // Users who already keep Memry and Obsidian on one folder chose that long
    // ago. Asking on every open would only nag them.
    ['an Obsidian vault Memry already opened', { ...VAULT_FILES, '.memry/config.json': '{}' }]
  ])('opens %s without asking', async (_name, files) => {
    const vault = path.join(root, 'Folder')
    writeTree(vault, files)

    const opened = await resolveObsidianVaultOpen(vault)

    expect(opened).toBe(vault)
    expect(showMessageBox).not.toHaveBeenCalled()
    expect(fs.readdirSync(root)).toEqual(['Folder'])
  })

  it('opens the Memry copy made last time instead of copying again', async () => {
    const vault = obsidianVault()
    const copy = path.join(root, 'My Vault-memrynote')
    writeTree(copy, { 'Tasks.md': '- [ ] Renew passport {task:abc}\n', '.memry/config.json': '{}' })
    const copyBefore = snapshot(copy)
    answer(CREATE_COPY)

    const opened = await resolveObsidianVaultOpen(vault)

    expect(opened).toBe(copy)
    expect(snapshot(copy)).toEqual(copyBefore)
    expect(fs.readdirSync(root).toSorted()).toEqual(['My Vault', 'My Vault-memrynote'])
  })

  it('leaves a folder that only shares the copy name alone and copies to the next name', async () => {
    const vault = obsidianVault()
    const stranger = path.join(root, 'My Vault-memrynote')
    writeTree(stranger, { 'unrelated.txt': 'not a vault' })
    answer(CREATE_COPY)

    const opened = await resolveObsidianVaultOpen(vault)

    expect(opened).toBe(path.join(root, 'My Vault-memrynote-2'))
    expect(snapshot(stranger)).toEqual({ 'unrelated.txt': expect.stringMatching(/^not a vault@/) })
    expect(fs.existsSync(path.join(root, 'My Vault-memrynote-2', 'Tasks.md'))).toBe(true)
  })

  // A file the copy cannot read fails it part way. Root can read any file, and
  // Windows ignores the mode bits, so neither can make the copy fail this way.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'leaves nothing beside the vault when the copy fails',
    async () => {
      const vault = obsidianVault()
      const unreadable = path.join(vault, 'Daily Notes', '2026-10-20.md')
      fs.chmodSync(unreadable, 0o000)
      answer(CREATE_COPY)

      try {
        await expect(resolveObsidianVaultOpen(vault)).rejects.toThrow(
          /EACCES: permission denied, copyfile/
        )
      } finally {
        fs.chmodSync(unreadable, 0o644)
      }

      expect(fs.readdirSync(root)).toEqual(['My Vault'])
    }
  )
})

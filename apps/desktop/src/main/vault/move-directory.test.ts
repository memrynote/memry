import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { moveDirectory, recoverStrandedFolderMoves } from './move-directory'
import { isAppFolderChange } from './app-folder-changes'
import type * as PromisesModule from 'fs/promises'

const { windows } = vi.hoisted(() => ({
  windows: {
    held: false,
    lockedFiles: new Set<string>(),
    stagingLocked: false,
    beforeRename: null as null | ((from: string) => Promise<void>)
  }
}))

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code })
}

// Windows under the vault watcher, as measured on a windows-2022 runner: the
// watcher holds every directory open, so a directory with a subdirectory
// refuses to be renamed, while a leaf directory and plain files still move.
// Dot-named directories are ignored by the watcher, so nothing holds them.
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof PromisesModule>()
  const rename = async (from: string, to: string): Promise<void> => {
    await windows.beforeRename?.(from)
    if (windows.lockedFiles.has(path.basename(from))) throw errno('EPERM')
    if (windows.stagingLocked && from.includes('.memry-move-')) throw errno('EIO')
    if (windows.held && !path.basename(from).startsWith('.')) {
      const stat = await actual.stat(from)
      if (stat.isDirectory()) {
        const entries = await actual.readdir(from, { withFileTypes: true })
        if (entries.some((entry) => entry.isDirectory())) throw errno('EPERM')
      }
    }
    return actual.rename(from, to)
  }
  return { ...actual, default: { ...actual, rename }, rename }
})

// Windows and macOS resolve names case-insensitively; emulate that so the test
// also holds on a case-sensitive filesystem.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  const existsSync = (p: string): boolean =>
    actual.existsSync(p) ||
    (actual.existsSync(path.dirname(p)) &&
      actual
        .readdirSync(path.dirname(p))
        .some((name) => name.toLowerCase() === path.basename(p).toLowerCase()))
  return { ...actual, default: { ...actual, existsSync }, existsSync }
})

vi.mock('../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

let root: string

function write(rel: string): void {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, rel)
}

function tree(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (dir === root && entry.name === '.memry') continue
      const rel = path.relative(root, path.join(dir, entry.name)).split(path.sep).join('/')
      if (entry.isDirectory()) {
        out.push(`${rel}/`)
        walk(path.join(dir, entry.name))
      } else {
        out.push(rel)
      }
    }
  }
  walk(root)
  return out.toSorted()
}

describe('moveDirectory', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'move-directory-'))
    windows.held = true
    windows.lockedFiles.clear()
    windows.stagingLocked = false
    windows.beforeRename = null
    write('Beta/b.md')
    write('Beta/Gamma/g.md')
    write('Beta/Gamma/Deep/deep.md')
    fs.mkdirSync(path.join(root, 'Beta/EmptyChild'))
    fs.mkdirSync(path.join(root, 'Delta'))
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('moves a folder that holds a subfolder when the directory itself cannot be renamed', async () => {
    await moveDirectory(root, 'Beta', 'Delta/Beta')

    expect(tree()).toEqual([
      'Delta/',
      'Delta/Beta/',
      'Delta/Beta/EmptyChild/',
      'Delta/Beta/Gamma/',
      'Delta/Beta/Gamma/Deep/',
      'Delta/Beta/Gamma/Deep/deep.md',
      'Delta/Beta/Gamma/g.md',
      'Delta/Beta/b.md'
    ])
  })

  it('puts every entry back when one file cannot be moved', async () => {
    windows.lockedFiles.add('g.md')

    await expect(moveDirectory(root, 'Beta', 'Delta/Beta')).rejects.toMatchObject({ code: 'EPERM' })

    expect(tree()).toEqual([
      'Beta/',
      'Beta/EmptyChild/',
      'Beta/Gamma/',
      'Beta/Gamma/Deep/',
      'Beta/Gamma/Deep/deep.md',
      'Beta/Gamma/g.md',
      'Beta/b.md',
      'Delta/'
    ])
  })

  it('renames a folder that holds a subfolder to a case-only variant of its own name', async () => {
    await moveDirectory(root, 'Beta', 'beta')

    expect(fs.readdirSync(root)).toContain('beta')
    expect(fs.readdirSync(root)).not.toContain('Beta')
    expect(tree()).toContain('beta/Gamma/Deep/deep.md')
    expect(tree()).toContain('beta/b.md')
  })

  it('refuses to merge into a folder that already exists', async () => {
    write('Delta/Beta/other.md')

    await expect(moveDirectory(root, 'Beta', 'Delta/Beta')).rejects.toMatchObject({ code: 'EPERM' })

    expect(tree()).toEqual([
      'Beta/',
      'Beta/EmptyChild/',
      'Beta/Gamma/',
      'Beta/Gamma/Deep/',
      'Beta/Gamma/Deep/deep.md',
      'Beta/Gamma/g.md',
      'Beta/b.md',
      'Delta/',
      'Delta/Beta/',
      'Delta/Beta/other.md'
    ])
  })

  it('renames in one step where nothing holds the tree', async () => {
    windows.held = false

    await moveDirectory(root, 'Beta', 'Delta/Beta')

    expect(tree()).toEqual([
      'Delta/',
      'Delta/Beta/',
      'Delta/Beta/EmptyChild/',
      'Delta/Beta/Gamma/',
      'Delta/Beta/Gamma/Deep/',
      'Delta/Beta/Gamma/Deep/deep.md',
      'Delta/Beta/Gamma/g.md',
      'Delta/Beta/b.md'
    ])
  })

  it('puts back a move that could not finish or undo at the next open, overwriting nothing', async () => {
    windows.stagingLocked = true

    await expect(moveDirectory(root, 'Beta', 'Delta/Beta')).rejects.toMatchObject({ code: 'EIO' })
    // Its notes' files are hidden in the staging directory, not gone.
    expect(tree()).not.toContain('Beta/b.md')
    expect(isAppFolderChange('Beta/Gamma/g.md')).toBe(true)
    // Its record is the Tauri app's serde output, byte for byte.
    const [staging] = fs.readdirSync(path.join(root, 'Delta'))
    const id = staging.slice('.memry-move-'.length)
    expect(fs.readdirSync(path.join(root, '.memry/moves'))).toEqual([`${id}.json`])
    expect(fs.readFileSync(path.join(root, `.memry/moves/${id}.json`), 'utf8')).toBe(
      `{"version":1,"from":"Beta","staging":"Delta/${staging}"}`
    )

    windows.stagingLocked = false
    fs.writeFileSync(path.join(root, 'Beta/b.md'), 'written since')
    await recoverStrandedFolderMoves(root)

    expect(fs.readFileSync(path.join(root, 'Beta/b.md'), 'utf8')).toBe('written since')
    expect(tree()).toContain('Beta/Gamma/Deep/deep.md')
    expect(isAppFolderChange('Beta/Gamma/g.md')).toBe(true)

    fs.rmSync(path.join(root, 'Beta/b.md'))
    await recoverStrandedFolderMoves(root)

    expect(tree()).toEqual([
      'Beta/',
      'Beta/EmptyChild/',
      'Beta/Gamma/',
      'Beta/Gamma/Deep/',
      'Beta/Gamma/Deep/deep.md',
      'Beta/Gamma/g.md',
      'Beta/b.md',
      'Delta/'
    ])
    expect(fs.readFileSync(path.join(root, 'Beta/b.md'), 'utf8')).toBe('Beta/b.md')
    expect(isAppFolderChange('Beta/Gamma/g.md')).toBe(false)
  })

  it('leaves a move this process is still running to that move', async () => {
    let resume = (): void => {}
    const paused = new Promise<void>((reached) => {
      windows.beforeRename = async (from) => {
        if (path.basename(from) !== 'g.md') return
        reached()
        await new Promise<void>((resolve) => (resume = resolve))
      }
    })
    const move = moveDirectory(root, 'Beta', 'Delta/Beta')
    await paused

    // A vault open of the same vault meanwhile.
    await recoverStrandedFolderMoves(root)
    resume()

    await expect(move).resolves.toBeUndefined()
    expect(tree()).toContain('Delta/Beta/Gamma/g.md')
    expect(fs.readdirSync(path.join(root, '.memry/moves'))).toEqual([])
  })
})

describe('recoverStrandedFolderMoves', () => {
  const id = '0123456789ab'
  const staging = `.memry-move-${id}`
  const recordPath = (): string => path.join(root, `.memry/moves/${id}.json`)

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'move-recovery-'))
    windows.held = false
    windows.stagingLocked = false
    windows.beforeRename = null
    write('Beta/b.md')
    write(`${staging}/Gamma/g.md`)
    fs.mkdirSync(path.join(root, '.memry/moves'), { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('puts back a move the Tauri app recorded', async () => {
    fs.writeFileSync(
      recordPath(),
      JSON.stringify({ version: 1, from: 'Beta', staging, shown: 'Beta (incomplete move)' })
    )

    await recoverStrandedFolderMoves(root)

    expect(tree()).toEqual(['Beta/', 'Beta/Gamma/', 'Beta/Gamma/g.md', 'Beta/b.md'])
    expect(fs.existsSync(recordPath())).toBe(false)
  })

  it.each([
    { record: { version: 2, from: 'Beta', staging }, held: true },
    { record: { version: 1, staging, shown: 'Moved folder (incomplete move)' }, held: false },
    { record: { version: 1, from: 'Beta', staging: '.memry-move-ba9876543210' }, held: false },
    { record: { version: 1, from: '.memry/Beta', staging }, held: false },
    { record: { version: 1, from: `${staging}/Beta`, staging }, held: false },
    { record: { version: 1, from: '../Beta', staging }, held: false },
    { record: 'not json', held: false }
  ])('leaves alone a record it cannot act on: $record', async ({ record, held }) => {
    const text = typeof record === 'string' ? record : JSON.stringify(record)
    fs.writeFileSync(recordPath(), text)

    await recoverStrandedFolderMoves(root)

    expect(tree()).toEqual([
      `${staging}/`,
      `${staging}/Gamma/`,
      `${staging}/Gamma/g.md`,
      'Beta/',
      'Beta/b.md'
    ])
    expect(fs.readFileSync(recordPath(), 'utf8')).toBe(text)
    expect(isAppFolderChange('Beta/b.md')).toBe(held)
  })
})

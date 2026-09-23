import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { moveDirectory } from './move-directory'

const { windows } = vi.hoisted(() => ({
  windows: { held: false, lockedFiles: new Set<string>() }
}))

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code })
}

// Windows under the vault watcher, as measured on a windows-2022 runner: the
// watcher holds every directory open, so a directory with a subdirectory
// refuses to be renamed, while a leaf directory and plain files still move.
// Dot-named directories are ignored by the watcher, so nothing holds them.
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  const rename = async (from: string, to: string): Promise<void> => {
    if (windows.lockedFiles.has(path.basename(from))) throw errno('EPERM')
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
  return out.sort()
}

describe('moveDirectory', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'move-directory-'))
    windows.held = true
    windows.lockedFiles.clear()
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
    await moveDirectory(path.join(root, 'Beta'), path.join(root, 'Delta/Beta'))

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

    await expect(
      moveDirectory(path.join(root, 'Beta'), path.join(root, 'Delta/Beta'))
    ).rejects.toMatchObject({ code: 'EPERM' })

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

  it('refuses to merge into a folder that already exists', async () => {
    write('Delta/Beta/other.md')

    await expect(
      moveDirectory(path.join(root, 'Beta'), path.join(root, 'Delta/Beta'))
    ).rejects.toMatchObject({ code: 'EPERM' })

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

    await moveDirectory(path.join(root, 'Beta'), path.join(root, 'Delta/Beta'))

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
})

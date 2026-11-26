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
    /** Runs before every rename, link and copy the app makes. */
    beforeMove: null as null | ((from: string) => Promise<void>),
    /** Runs before every directory read. */
    beforeReaddir: null as null | ((dir: string) => Promise<void>),
    noHardLinks: false,
    unlinkFails: null as null | ((p: string) => string | null),
    /** Inodes a lock holds: no name of them can be unlinked. */
    lockedInodes: new Set<bigint>(),
    /** The volume gives every file inode 0 (SMB, WebDAV, cloud redirectors). */
    zeroInodes: false,
    /** Fails a rename, link or copy with the code it returns. */
    refuse: null as null | ((from: string, to: string) => string | null),
    /** The app dies right after its `crashAfter`th change to the disk. */
    crashAfter: Infinity,
    changes: 0
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
  // Every change to the disk: once the app has died, none happens.
  const change =
    <A extends unknown[], R>(run: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      if (windows.changes >= windows.crashAfter) throw errno('ECRASH')
      const result = await run(...args)
      windows.changes++
      return result
    }
  const refused = (from: string, to: string): void => {
    const code = windows.refuse?.(from, to)
    if (code) throw errno(code)
  }
  const zeroed = <S extends { ino: bigint | number }>(p: string, stat: S): S => {
    if (windows.zeroInodes && !p.includes(`${path.sep}.memry${path.sep}`)) {
      stat.ino = typeof stat.ino === 'bigint' ? 0n : 0
    }
    return stat
  }
  const rename = async (from: string, to: string): Promise<void> => {
    await windows.beforeMove?.(from)
    refused(from, to)
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
  const link = async (from: string, to: string): Promise<void> => {
    await windows.beforeMove?.(from)
    refused(from, to)
    if (windows.lockedFiles.has(path.basename(from)) || windows.noHardLinks) throw errno('EPERM')
    return actual.link(from, to)
  }
  const unlink = async (p: string): Promise<void> => {
    const code = windows.unlinkFails?.(p)
    if (code) throw errno(code)
    const stat = await actual.lstat(p, { bigint: true }).catch(() => null)
    if (stat && windows.lockedInodes.has(stat.ino)) throw errno('EBUSY')
    return actual.unlink(p)
  }
  const lstat = (async (p: string, options?: { bigint?: boolean }) =>
    zeroed(p, await actual.lstat(p, options))) as typeof actual.lstat
  const open = (async (p: string, ...rest: unknown[]) => {
    const handle = await (
      actual.open as (...args: unknown[]) => Promise<PromisesModule.FileHandle>
    )(p, ...rest)
    const stat = handle.stat.bind(handle)
    handle.stat = (async (options?: { bigint?: boolean }) =>
      zeroed(p, await stat(options))) as typeof handle.stat
    return handle
  }) as typeof actual.open
  const readdir = (async (dir: string, ...rest: unknown[]) => {
    await windows.beforeReaddir?.(dir)
    return (actual.readdir as (...args: unknown[]) => Promise<unknown>)(dir, ...rest)
  }) as typeof actual.readdir
  const copyFile = async (from: string, to: string, mode?: number): Promise<void> => {
    await windows.beforeMove?.(from)
    refused(from, to)
    if (windows.lockedFiles.has(path.basename(from))) throw errno('EPERM')
    return actual.copyFile(from, to, mode)
  }
  const mocked = {
    rename: change(rename),
    link: change(link),
    copyFile: change(copyFile),
    unlink: change(unlink),
    rm: change(actual.rm),
    rmdir: change(actual.rmdir),
    mkdir: change(actual.mkdir),
    readdir,
    lstat,
    open
  }
  return { ...actual, default: { ...actual, ...mocked }, ...mocked }
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
    windows.beforeMove = null
    windows.beforeReaddir = null
    windows.noHardLinks = false
    windows.unlinkFails = null
    windows.lockedInodes.clear()
    windows.zeroInodes = false
    windows.refuse = null
    windows.crashAfter = Infinity
    windows.changes = 0
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

    // The name taken meanwhile keeps its file; the note comes back beside it.
    expect(tree()).toEqual([
      'Beta/',
      'Beta/EmptyChild/',
      'Beta/Gamma/',
      'Beta/Gamma/Deep/',
      'Beta/Gamma/Deep/deep.md',
      'Beta/Gamma/g.md',
      'Beta/b (conflict copy).md',
      'Beta/b.md',
      'Delta/'
    ])
    expect(fs.readFileSync(path.join(root, 'Beta/b.md'), 'utf8')).toBe('written since')
    expect(fs.readFileSync(path.join(root, 'Beta/b (conflict copy).md'), 'utf8')).toBe('Beta/b.md')
    expect(fs.readdirSync(path.join(root, '.memry/moves'))).toEqual([])
    expect(isAppFolderChange('Beta/Gamma/g.md')).toBe(false)
  })

  it('leaves a move this process is still running to a sweep started during it', async () => {
    let resume = (): void => {}
    const paused = new Promise<void>((reached) => {
      windows.beforeMove = async (from) => {
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
    expect(tree().some((rel) => rel.includes('incomplete move'))).toBe(false)
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
    windows.lockedFiles.clear()
    windows.stagingLocked = false
    windows.beforeMove = null
    windows.beforeReaddir = null
    windows.noHardLinks = false
    windows.unlinkFails = null
    windows.lockedInodes.clear()
    windows.zeroInodes = false
    windows.refuse = null
    windows.crashAfter = Infinity
    windows.changes = 0
    write('Beta/b.md')
    write(`${staging}/Gamma/g.md`)
    fs.mkdirSync(path.join(root, '.memry/moves'), { recursive: true })
  })

  afterEach(() => {
    vi.useRealTimers()
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('moves what cannot go back into a visible folder, and lets go of the source', async () => {
    fs.writeFileSync(recordPath(), JSON.stringify({ version: 1, from: 'Beta', staging }))
    write('Beta/Gamma/other.md')
    windows.lockedFiles.add('g.md')

    await recoverStrandedFolderMoves(root)

    expect(tree()).toEqual([
      'Beta (incomplete move)/',
      'Beta (incomplete move)/Gamma/',
      'Beta (incomplete move)/Gamma/g.md',
      'Beta/',
      'Beta/Gamma/',
      'Beta/Gamma/other.md',
      'Beta/b.md'
    ])
    expect(fs.existsSync(recordPath())).toBe(false)
    expect(isAppFolderChange('Beta/b.md')).toBe(false)
  })

  it('shows a staging directory no record names, wherever it is', async () => {
    write('Delta/.memry-move-ba9876543210/d.md')
    write('Moved folder (incomplete move)/taken.md')

    await recoverStrandedFolderMoves(root)

    expect(tree()).toEqual([
      'Beta/',
      'Beta/b.md',
      'Delta/',
      'Delta/Moved folder (incomplete move)/',
      'Delta/Moved folder (incomplete move)/d.md',
      'Moved folder (incomplete move 2)/',
      'Moved folder (incomplete move 2)/Gamma/',
      'Moved folder (incomplete move 2)/Gamma/g.md',
      'Moved folder (incomplete move)/',
      'Moved folder (incomplete move)/taken.md'
    ])
  })

  it.each([
    {
      kind: 'a link',
      make: () => {
        const target = path.join(root, 'record.json')
        fs.writeFileSync(target, JSON.stringify({ version: 1, from: 'Beta', staging }))
        fs.symlinkSync(target, recordPath())
      }
    },
    {
      kind: 'longer than 4 KiB',
      make: () =>
        fs.writeFileSync(
          recordPath(),
          JSON.stringify({ version: 1, from: 'Beta', staging }).padEnd(4097, ' ')
        )
    }
  ])('reads no record that is $kind, and shows its folder', async ({ make }) => {
    make()

    await recoverStrandedFolderMoves(root)

    expect(tree()).toContain('Moved folder (incomplete move)/Gamma/g.md')
    expect(tree()).not.toContain('Beta/Gamma/g.md')
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

  // A newer build's record stays for that build; any other goes with its folder.
  it.each([
    { record: { version: 2, from: 'Beta', staging }, kept: true },
    { record: { version: 1, staging }, kept: false },
    { record: { version: 1, from: 'Beta', staging: '.memry-move-ba9876543210' }, kept: false },
    { record: { version: 1, from: '.memry/Beta', staging }, kept: false },
    { record: { version: 1, from: `${staging}/Beta`, staging }, kept: false },
    { record: { version: 1, from: '../Beta', staging }, kept: false },
    { record: 'not json', kept: false }
  ])('shows the folder of a record it cannot put back: $record', async ({ record, kept }) => {
    const text = typeof record === 'string' ? record : JSON.stringify(record)
    fs.writeFileSync(recordPath(), text)

    await recoverStrandedFolderMoves(root)

    expect(tree()).toEqual([
      'Beta/',
      'Beta/b.md',
      'Moved folder (incomplete move)/',
      'Moved folder (incomplete move)/Gamma/',
      'Moved folder (incomplete move)/Gamma/g.md'
    ])
    expect(fs.existsSync(recordPath()) && fs.readFileSync(recordPath(), 'utf8')).toBe(kept && text)
    expect(isAppFolderChange('Beta/b.md')).toBe(kept)
  })

  it('keeps a record it cannot read while its folder is still hidden', async () => {
    fs.writeFileSync(recordPath(), 'not json')
    fs.mkdirSync(path.join(root, 'Moved folder (incomplete move)'))
    for (let n = 2; n <= 1000; n++) {
      fs.mkdirSync(path.join(root, `Moved folder (incomplete move ${n})`))
    }

    await recoverStrandedFolderMoves(root)

    expect(fs.existsSync(path.join(root, staging))).toBe(true)
    expect(fs.readFileSync(recordPath(), 'utf8')).toBe('not json')
  })

  it('shows into the folder a sweep killed mid-show named', async () => {
    fs.writeFileSync(
      recordPath(),
      JSON.stringify({ version: 1, from: 'Beta', staging, shown: 'Beta (incomplete move)' })
    )
    write('Beta (incomplete move)/shown.md')
    write('Beta/Gamma/other.md')
    windows.lockedFiles.add('g.md')

    await recoverStrandedFolderMoves(root)

    expect(tree()).toEqual([
      'Beta (incomplete move)/',
      'Beta (incomplete move)/Gamma/',
      'Beta (incomplete move)/Gamma/g.md',
      'Beta (incomplete move)/shown.md',
      'Beta/',
      'Beta/Gamma/',
      'Beta/Gamma/other.md',
      'Beta/b.md'
    ])
    expect(fs.existsSync(recordPath())).toBe(false)
  })

  it('leaves a staging directory in an excluded folder alone', async () => {
    fs.writeFileSync(recordPath(), JSON.stringify({ version: 1, from: 'Beta', staging }))
    write('node_modules/.memry-move-ba9876543210/d.md')

    await recoverStrandedFolderMoves(root)

    expect(tree()).toContain('node_modules/.memry-move-ba9876543210/d.md')
    expect(tree().some((rel) => rel.includes('incomplete move'))).toBe(false)
  })

  it('never replaces a file that lands at a put-back target just before it goes back', async () => {
    fs.writeFileSync(recordPath(), JSON.stringify({ version: 1, from: 'Beta', staging }))
    write(`${staging}/c.md`)
    let landed = false
    windows.beforeMove = async (from) => {
      if (path.basename(from) === 'c.md' && !landed) {
        landed = true
        fs.writeFileSync(path.join(root, 'Beta/c.md'), 'landed')
      }
    }

    await recoverStrandedFolderMoves(root)

    expect(fs.readFileSync(path.join(root, 'Beta/c.md'), 'utf8')).toBe('landed')
    expect(fs.readFileSync(path.join(root, 'Beta/c (conflict copy).md'), 'utf8')).toBe(
      `${staging}/c.md`
    )
    expect(fs.existsSync(path.join(root, staging))).toBe(false)
  })

  it('never replaces a file that lands at a conflict name just before the copy goes there', async () => {
    fs.writeFileSync(recordPath(), JSON.stringify({ version: 1, from: 'Beta', staging }))
    write(`${staging}/b.md`)
    const landing = path.join(root, 'Beta/b (conflict copy).md')
    let landed = false
    windows.beforeMove = async (from) => {
      if (path.basename(from) === 'b.md' && !landed) {
        landed = true
        fs.writeFileSync(landing, 'landed')
      }
    }

    await recoverStrandedFolderMoves(root)

    expect(fs.readFileSync(landing, 'utf8')).toBe('landed')
    expect(fs.readFileSync(path.join(root, 'Beta/b (conflict copy 2).md'), 'utf8')).toBe(
      `${staging}/b.md`
    )
  })

  /** The record of a put-back that was about to place `staged` at `target`. */
  const placing = (staged: string, target: string, ino?: string): string => {
    const stat = fs.statSync(path.join(root, staged), { bigint: true })
    const placed = [{ staged, target, dev: String(stat.dev), ino: ino ?? String(stat.ino) }]
    return JSON.stringify({ version: 1, from: 'Beta', staging, placed })
  }
  const inodeOf = (rel: string): bigint => fs.statSync(path.join(root, rel), { bigint: true }).ino
  const records = (): string[] =>
    fs.readdirSync(path.join(root, '.memry/moves')).filter((name) => name.endsWith('.json'))

  it('finishes a put-back cut short after the link without a conflict copy of the same file', async () => {
    write(`${staging}/c.md`)
    fs.writeFileSync(recordPath(), placing(`${staging}/c.md`, 'Beta/c.md'))
    fs.linkSync(path.join(root, staging, 'c.md'), path.join(root, 'Beta/c.md'))

    await recoverStrandedFolderMoves(root)

    expect(tree()).toEqual(['Beta/', 'Beta/Gamma/', 'Beta/Gamma/g.md', 'Beta/b.md', 'Beta/c.md'])
    expect(fs.readFileSync(path.join(root, 'Beta/c.md'), 'utf8')).toBe(`${staging}/c.md`)
    expect(records()).toEqual([])
  })

  it('keeps the staged name of a placed file a lock holds, and shows nothing, until a later open', async () => {
    fs.writeFileSync(recordPath(), JSON.stringify({ version: 1, from: 'Beta', staging }))
    write(`${staging}/c.md`)
    // A lock on the file itself: no name of it can be unlinked.
    windows.lockedInodes.add(inodeOf(`${staging}/c.md`))

    await recoverStrandedFolderMoves(root)

    expect(tree()).toEqual([
      `${staging}/`,
      `${staging}/c.md`,
      'Beta/',
      'Beta/Gamma/',
      'Beta/Gamma/g.md',
      'Beta/b.md',
      'Beta/c.md'
    ])
    expect(records()).toEqual([`${id}.json`])
    expect(isAppFolderChange('Beta/c.md')).toBe(true)

    windows.lockedInodes.clear()
    await recoverStrandedFolderMoves(root)

    expect(tree()).toEqual(['Beta/', 'Beta/Gamma/', 'Beta/Gamma/g.md', 'Beta/b.md', 'Beta/c.md'])
    expect(records()).toEqual([])
    expect(isAppFolderChange('Beta/c.md')).toBe(false)
  })

  it('shows no second visible copy of a locked file on any open while the lock lasts', async () => {
    fs.writeFileSync(recordPath(), JSON.stringify({ version: 1, from: 'Beta', staging }))
    write(`${staging}/c.md`)
    windows.lockedInodes.add(inodeOf(`${staging}/c.md`))

    for (const open of [1, 2, 3]) {
      if (open === 3) windows.lockedInodes.clear()
      await recoverStrandedFolderMoves(root)
      expect(
        tree().filter((rel) => path.posix.basename(rel) === 'c.md' && !rel.startsWith('.'))
      ).toEqual(['Beta/c.md'])
    }
    expect(tree()).toEqual(['Beta/', 'Beta/Gamma/', 'Beta/Gamma/g.md', 'Beta/b.md', 'Beta/c.md'])
  })

  it('unlinks a placed file from its staged folder instead of moving the folder to a second place', async () => {
    const shownFolder = 'Beta (incomplete move)'
    fs.mkdirSync(path.join(root, shownFolder, 'Gamma'), { recursive: true })
    fs.linkSync(path.join(root, staging, 'Gamma/g.md'), path.join(root, shownFolder, 'Gamma/g.md'))
    const record = JSON.parse(placing(`${staging}/Gamma/g.md`, `${shownFolder}/Gamma/g.md`))
    fs.writeFileSync(recordPath(), JSON.stringify({ ...record, shown: shownFolder }))

    await recoverStrandedFolderMoves(root)

    expect(tree()).toEqual([
      `${shownFolder}/`,
      `${shownFolder}/Gamma/`,
      `${shownFolder}/Gamma/g.md`,
      'Beta/',
      'Beta/Gamma/',
      'Beta/b.md'
    ])
    expect(records()).toEqual([])
  })

  it.each([
    { staged: 'Beta/b.md', target: 'Beta/b.md' },
    { staged: `${staging}/Gamma/g.md`, target: `${staging}/Gamma/g.md` }
  ])('refuses a record that places $staged at $target', async ({ staged, target }) => {
    fs.writeFileSync(recordPath(), placing(staged, target))

    await recoverStrandedFolderMoves(root)

    expect(tree()).toEqual([
      'Beta/',
      'Beta/b.md',
      'Moved folder (incomplete move)/',
      'Moved folder (incomplete move)/Gamma/',
      'Moved folder (incomplete move)/Gamma/g.md'
    ])
  })

  it('never unlinks a file at a target the put-back did not create, even with the same bytes', async () => {
    fs.writeFileSync(recordPath(), JSON.stringify({ version: 1, from: 'Beta', staging }))
    write(`${staging}/c.md`)
    fs.writeFileSync(path.join(root, 'Beta/c.md'), `${staging}/c.md`)
    const users = inodeOf('Beta/c.md')
    windows.lockedInodes.add(inodeOf(`${staging}/c.md`))

    await recoverStrandedFolderMoves(root)
    windows.lockedInodes.clear()
    await recoverStrandedFolderMoves(root)

    expect(inodeOf('Beta/c.md')).toBe(users)
    expect(tree()).toEqual([
      'Beta/',
      'Beta/Gamma/',
      'Beta/Gamma/g.md',
      'Beta/b.md',
      'Beta/c (conflict copy).md',
      'Beta/c.md'
    ])
  })

  it('never takes a file on a volume with inode 0 for the one the put-back placed', async () => {
    windows.zeroInodes = true
    fs.writeFileSync(path.join(root, `${staging}/b.md`), 'STAGED!!!')
    fs.writeFileSync(path.join(root, 'Beta/b.md'), 'USERFILE!')
    // The put-back recorded inode 0 for Beta/b.md, then found it taken.
    fs.writeFileSync(recordPath(), placing(`${staging}/b.md`, 'Beta/b.md', '0'))

    await recoverStrandedFolderMoves(root)

    expect(fs.readFileSync(path.join(root, 'Beta/b.md'), 'utf8')).toBe('USERFILE!')
    expect(fs.readFileSync(path.join(root, 'Beta/b (conflict copy).md'), 'utf8')).toBe('STAGED!!!')
    expect(records()).toEqual([])
  })

  it('never takes identical bytes at a target recorded with inode 0 for the placed file', async () => {
    windows.zeroInodes = true
    write(`${staging}/c.md`)
    fs.writeFileSync(path.join(root, 'Beta/c.md'), `${staging}/c.md`)
    const users = inodeOf('Beta/c.md')
    fs.writeFileSync(recordPath(), placing(`${staging}/c.md`, 'Beta/c.md', '0'))

    await recoverStrandedFolderMoves(root)

    expect(inodeOf('Beta/c.md')).toBe(users)
    expect(fs.readFileSync(path.join(root, 'Beta/c (conflict copy).md'), 'utf8')).toBe(
      `${staging}/c.md`
    )
    expect(fs.existsSync(path.join(root, staging))).toBe(false)
  })

  it('finishes a linked put-back whose device number changed since, without a conflict copy', async () => {
    write(`${staging}/c.md`)
    fs.linkSync(path.join(root, staging, 'c.md'), path.join(root, 'Beta/c.md'))
    const stat = fs.statSync(path.join(root, staging, 'c.md'), { bigint: true })
    // A remount or reboot gave the volume another device number.
    const placed = [
      {
        staged: `${staging}/c.md`,
        target: 'Beta/c.md',
        dev: String(stat.dev + 1n),
        ino: String(stat.ino)
      }
    ]
    fs.writeFileSync(recordPath(), JSON.stringify({ version: 1, from: 'Beta', staging, placed }))

    await recoverStrandedFolderMoves(root)

    expect(tree()).toEqual(['Beta/', 'Beta/Gamma/', 'Beta/Gamma/g.md', 'Beta/b.md', 'Beta/c.md'])
    expect(records()).toEqual([])
  })

  it('removes only the copy its record names on a volume with no hard links', async () => {
    windows.noHardLinks = true
    write(`${staging}/c.md`)
    fs.writeFileSync(path.join(root, 'Beta/.memry-put-back'), 'USER')
    const temp = 'Beta/.memry-put-back-aaaaaaaaaaaa'
    fs.writeFileSync(path.join(root, temp), 'half a cop')
    const record = JSON.parse(placing(`${staging}/c.md`, 'Beta/c.md'))
    record.placed[0].temp = temp
    fs.writeFileSync(recordPath(), JSON.stringify(record))

    await recoverStrandedFolderMoves(root)

    expect(tree()).toEqual([
      'Beta/',
      'Beta/.memry-put-back',
      'Beta/Gamma/',
      'Beta/Gamma/g.md',
      'Beta/b.md',
      'Beta/c.md'
    ])
    expect(fs.readFileSync(path.join(root, 'Beta/.memry-put-back'), 'utf8')).toBe('USER')
    expect(fs.readFileSync(path.join(root, 'Beta/c.md'), 'utf8')).toBe(`${staging}/c.md`)
    expect(records()).toEqual([])
  })

  it('removes its half copy when a copy fails on a volume with no hard links', async () => {
    windows.noHardLinks = true
    write(`${staging}/c.md`)
    fs.writeFileSync(path.join(root, 'Beta/.memry-put-back'), 'USER')
    // The disk fills partway through the copy.
    windows.refuse = (_from, to) => {
      if (!path.basename(to).startsWith('.memry-put-back-')) return null
      fs.writeFileSync(to, 'half')
      return 'ENOSPC'
    }
    fs.writeFileSync(recordPath(), JSON.stringify({ version: 1, from: 'Beta', staging }))

    await recoverStrandedFolderMoves(root)

    expect(tree().filter((rel) => rel.includes('.memry-put-back-'))).toEqual([])
    expect(tree()).toContain('Beta (incomplete move)/c.md')
    expect(fs.readFileSync(path.join(root, 'Beta (incomplete move)/c.md'), 'utf8')).toBe(
      `${staging}/c.md`
    )
    expect(fs.readFileSync(path.join(root, 'Beta/.memry-put-back'), 'utf8')).toBe('USER')
    expect(fs.readFileSync(path.join(root, 'Beta/b.md'), 'utf8')).toBe('Beta/b.md')
    expect(records()).toEqual([])
  })

  it.each(['Beta/b.md', 'Beta/.memry-put-back', 'Gamma/.memry-put-back-aaaaaaaaaaaa'])(
    'refuses a record that names %s as its copy',
    async (temp) => {
      write(`${staging}/c.md`)
      write('Gamma/.memry-put-back-aaaaaaaaaaaa')
      fs.writeFileSync(path.join(root, 'Beta/.memry-put-back'), 'USER')
      const record = JSON.parse(placing(`${staging}/c.md`, 'Beta/c.md'))
      record.placed[0].temp = temp
      fs.writeFileSync(recordPath(), JSON.stringify(record))

      await recoverStrandedFolderMoves(root)

      expect(fs.existsSync(path.join(root, temp))).toBe(true)
      expect(tree()).toContain('Moved folder (incomplete move)/c.md')
    }
  )

  it('reopens to one visible folder of what cannot go back after a crash at any show step', async () => {
    const stagingAbs = path.join(root, staging)
    const stranded = (): void => {
      fs.rmSync(root, { recursive: true, force: true })
      write('Beta/b.md')
      write(`${staging}/Gamma/g.md`)
      write(`${staging}/c.md`)
      write(`${staging}/d.md`)
      fs.mkdirSync(path.join(root, '.memry/moves'), { recursive: true })
      fs.writeFileSync(recordPath(), JSON.stringify({ version: 1, from: 'Beta', staging }))
      windows.changes = 0
    }
    // The refused staging rename is retried with backoff; skip its waits.
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const recover = async (): Promise<void> => {
      const state = { done: false }
      const run = recoverStrandedFolderMoves(root).finally(() => (state.done = true))
      while (!state.done) {
        await vi.advanceTimersByTimeAsync(1000)
        await new Promise((resolve) => setImmediate(resolve))
      }
      await run
    }
    // Nothing goes back into Beta, and the staging directory moves entry by entry.
    windows.refuse = (from, to) =>
      from === stagingAbs
        ? 'EPERM'
        : to.startsWith(path.join(root, 'Beta', path.sep))
          ? 'EIO'
          : null
    stranded()
    await recover()
    const shown = tree()
    expect(shown.filter((rel) => /^Beta \(incomplete move.*\)\/$/.test(rel))).toEqual([
      'Beta (incomplete move)/'
    ])
    expect(shown).toContain('Beta (incomplete move)/c.md')
    const steps = windows.changes

    for (let crashAfter = 1; crashAfter < steps; crashAfter++) {
      stranded()
      windows.crashAfter = crashAfter
      await recover()
      windows.crashAfter = Infinity
      await recover()
      expect(tree()).toEqual(shown)
      expect(records()).toEqual([])
    }
  })

  it.each([
    { volume: 'hard links', noHardLinks: false },
    { volume: 'no hard links', noHardLinks: true }
  ])(
    'reopens to exactly one copy of every note after a crash at any put-back step, on a volume with $volume',
    async ({ noHardLinks }) => {
      const stranded = (): void => {
        fs.rmSync(root, { recursive: true, force: true })
        write('Beta/b.md')
        write(`${staging}/Gamma/g.md`)
        write(`${staging}/b.md`)
        write(`${staging}/c.md`)
        fs.mkdirSync(path.join(root, '.memry/moves'), { recursive: true })
        fs.writeFileSync(recordPath(), JSON.stringify({ version: 1, from: 'Beta', staging }))
        windows.changes = 0
      }
      const expectOneCopyEach = (): void => {
        expect(tree()).toEqual([
          'Beta/',
          'Beta/Gamma/',
          'Beta/Gamma/g.md',
          'Beta/b (conflict copy).md',
          'Beta/b.md',
          'Beta/c.md'
        ])
        for (const [rel, bytes] of [
          ['Beta/b.md', 'Beta/b.md'],
          ['Beta/b (conflict copy).md', `${staging}/b.md`],
          ['Beta/c.md', `${staging}/c.md`],
          ['Beta/Gamma/g.md', `${staging}/Gamma/g.md`]
        ]) {
          expect(fs.readFileSync(path.join(root, rel), 'utf8')).toBe(bytes)
        }
        // A crash mid-write can leave the record's hidden temp file: no record.
        expect(records()).toEqual([])
      }
      windows.noHardLinks = noHardLinks
      stranded()
      await recoverStrandedFolderMoves(root)
      expectOneCopyEach()
      const steps = windows.changes

      for (let crashAfter = 1; crashAfter < steps; crashAfter++) {
        stranded()
        windows.crashAfter = crashAfter
        await recoverStrandedFolderMoves(root)
        windows.crashAfter = Infinity
        await recoverStrandedFolderMoves(root)
        expectOneCopyEach()
      }
    }
  )

  it('keeps hidden for the next open a move that fails and cannot undo during the sweep', async () => {
    write('Alpha/A1/a.md')
    write('Alpha/x.md')
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    let gated = (): void => {}
    const atGate = new Promise<void>((resolve) => (gated = resolve))
    windows.held = true
    const move = moveDirectory(root, 'Alpha', 'Moved')
    windows.beforeMove = async (from) => {
      if (path.basename(from) !== 'x.md') return
      gated()
      await gate
    }
    await atGate
    windows.beforeReaddir = async (dir) => {
      if (dir !== root) return
      // The move fails, and its undo too, once the sweep has read its record.
      windows.beforeReaddir = null
      windows.lockedFiles.add('x.md')
      windows.stagingLocked = true
      release()
      await expect(move).rejects.toMatchObject({ code: 'EPERM' })
      windows.stagingLocked = false
    }

    await recoverStrandedFolderMoves(root)

    expect(tree().some((rel) => rel.startsWith('Moved folder (incomplete move 2)'))).toBe(false)
    windows.lockedFiles.clear()
    await recoverStrandedFolderMoves(root)
    expect(tree()).toEqual([
      'Alpha/',
      'Alpha/A1/',
      'Alpha/A1/a.md',
      'Alpha/x.md',
      'Beta/',
      'Beta/b.md',
      'Moved folder (incomplete move)/',
      'Moved folder (incomplete move)/Gamma/',
      'Moved folder (incomplete move)/Gamma/g.md'
    ])
  })

  it('leaves alone a move started while the sweep reads the journal', async () => {
    write('Alpha/A1/a.md')
    write('Alpha/x.md')
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    let gated = (): void => {}
    const atGate = new Promise<void>((resolve) => (gated = resolve))
    let move: Promise<void> | null = null
    windows.beforeMove = async (from) => {
      if (path.basename(from) !== 'x.md') return
      gated()
      await gate
    }
    windows.beforeReaddir = async (dir) => {
      if (dir !== path.join(root, '.memry/moves') || move) return
      windows.held = true
      move = moveDirectory(root, 'Alpha', 'Moved')
      await atGate
    }

    await recoverStrandedFolderMoves(root)

    // The move is mid-way: its staging directory is as it left it.
    const moving =
      fs.readdirSync(root).find((name) => /^\.memry-move-(?!0123456789ab)/.test(name)) ?? 'missing'
    expect(tree().filter((rel) => rel.startsWith(moving))).toEqual([
      `${moving}/`,
      `${moving}/A1/`,
      `${moving}/A1/a.md`
    ])
    expect(tree()).toContain('Alpha/x.md')
    release()
    await expect(move).resolves.toBeUndefined()
    expect(tree()).toEqual(
      [
        'Moved folder (incomplete move)/',
        'Moved folder (incomplete move)/Gamma/',
        'Moved folder (incomplete move)/Gamma/g.md',
        'Beta/',
        'Beta/b.md',
        'Moved/',
        'Moved/A1/',
        'Moved/A1/a.md',
        'Moved/x.md'
      ].toSorted()
    )
  })

  it('leaves a move started during the sweep to that move', async () => {
    fs.writeFileSync(recordPath(), JSON.stringify({ version: 1, from: 'Beta', staging }))
    write('Alpha/A1/a.md')
    write('Alpha/x.md')
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    let gated = (): void => {}
    const atGate = new Promise<void>((resolve) => (gated = resolve))
    let move: Promise<void> | null = null
    windows.beforeMove = async (from) => {
      if (path.basename(from) === 'x.md') {
        gated()
        await gate
      } else if (path.basename(from) === 'Gamma' && !move) {
        // The user moves a folder while the open's sweep puts this one back.
        windows.held = true
        move = moveDirectory(root, 'Alpha', 'Moved')
        await atGate
      }
    }

    await recoverStrandedFolderMoves(root)
    release()

    await expect(move).resolves.toBeUndefined()
    expect(tree()).toEqual([
      'Beta/',
      'Beta/Gamma/',
      'Beta/Gamma/g.md',
      'Beta/b.md',
      'Moved/',
      'Moved/A1/',
      'Moved/A1/a.md',
      'Moved/x.md'
    ])
    expect(fs.readdirSync(path.join(root, '.memry/moves'))).toEqual([])
  })
})

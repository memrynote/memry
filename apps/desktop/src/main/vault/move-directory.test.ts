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
  const rename = async (from: string, to: string): Promise<void> => {
    await windows.beforeMove?.(from)
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
    if (windows.lockedFiles.has(path.basename(from)) || windows.noHardLinks) throw errno('EPERM')
    return actual.link(from, to)
  }
  const unlink = async (p: string): Promise<void> => {
    const code = windows.unlinkFails?.(p)
    if (code) throw errno(code)
    return actual.unlink(p)
  }
  const readdir = (async (dir: string, ...rest: unknown[]) => {
    await windows.beforeReaddir?.(dir)
    return (actual.readdir as (...args: unknown[]) => Promise<unknown>)(dir, ...rest)
  }) as typeof actual.readdir
  const copyFile = async (from: string, to: string, mode?: number): Promise<void> => {
    await windows.beforeMove?.(from)
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
    readdir
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
    windows.crashAfter = Infinity
    windows.changes = 0
    write('Beta/b.md')
    write(`${staging}/Gamma/g.md`)
    fs.mkdirSync(path.join(root, '.memry/moves'), { recursive: true })
  })

  afterEach(() => {
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

  it('finishes a put-back cut short after the link without a conflict copy of the same file', async () => {
    fs.writeFileSync(recordPath(), JSON.stringify({ version: 1, from: 'Beta', staging }))
    write(`${staging}/c.md`)
    fs.linkSync(path.join(root, staging, 'c.md'), path.join(root, 'Beta/c.md'))

    await recoverStrandedFolderMoves(root)

    expect(tree()).toEqual(['Beta/', 'Beta/Gamma/', 'Beta/Gamma/g.md', 'Beta/b.md', 'Beta/c.md'])
    expect(fs.readFileSync(path.join(root, 'Beta/c.md'), 'utf8')).toBe(`${staging}/c.md`)
  })

  it('takes a placed file back when its staged name cannot be unlinked', async () => {
    fs.writeFileSync(recordPath(), JSON.stringify({ version: 1, from: 'Beta', staging }))
    write(`${staging}/c.md`)
    windows.unlinkFails = (p) => (p.includes('.memry-move-') ? 'EBUSY' : null)

    await recoverStrandedFolderMoves(root)
    windows.unlinkFails = null
    await recoverStrandedFolderMoves(root)

    expect(tree()).toEqual([
      'Beta (incomplete move)/',
      'Beta (incomplete move)/c.md',
      'Beta/',
      'Beta/Gamma/',
      'Beta/Gamma/g.md',
      'Beta/b.md'
    ])
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
        expect(fs.readdirSync(path.join(root, '.memry/moves'))).toEqual([])
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

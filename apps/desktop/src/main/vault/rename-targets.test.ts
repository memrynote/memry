import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RenameTargets } from './rename-targets'

/**
 * A raw `rename` event names a basename only. The watcher reads it as the new
 * name in the watched file's folder, which is right for a rename in place and
 * wrong for a move to another folder under a new name.
 */
describe('RenameTargets', () => {
  let root: string
  let targets: RenameTargets
  const at = (relativePath: string): string => path.join(root, relativePath)

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-rename-targets-'))
    fs.mkdirSync(at('Docs'))
    fs.mkdirSync(at('Other'))
    targets = new RenameTargets()
  })

  afterEach(() => {
    targets.clear()
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('keeps the new name of a file renamed in its folder', () => {
    fs.writeFileSync(at('Docs/m.md'), '# m\n')
    fs.renameSync(at('Docs/m.md'), at('Docs/n.md'))

    targets.record(at('Docs/m.md'), at('Docs/n.md'))

    expect(targets.take(at('Docs/m.md'))).toBe(at('Docs/n.md'))
  })

  it('keeps no name for a file moved to another folder under a new name', () => {
    fs.writeFileSync(at('Docs/m.md'), '# m\n')
    fs.renameSync(at('Docs/m.md'), at('Other/n.md'))

    targets.record(at('Docs/m.md'), at('Docs/n.md'))

    expect(targets.take(at('Docs/m.md'))).toBeNull()
  })

  // A folder's watcher names the child that changed, not a new name.
  it("keeps no name for a folder's event about one of its files", () => {
    fs.writeFileSync(at('x.md'), '# x\n')
    fs.writeFileSync(at('Docs/x.md'), '# x\n')

    targets.record(at('Docs'), at('x.md'))

    expect(targets.take(at('Docs'))).toBeNull()
  })
})

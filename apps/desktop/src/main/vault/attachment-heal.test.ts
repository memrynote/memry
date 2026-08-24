/**
 * Tests for attachment-heal.ts — the resolve-time repair for attachment files
 * renamed on disk outside the app (#1713). The uniqueness rule is the safety
 * boundary: an ambiguous folder must never guess, and matching never leaves
 * the note's own attachments folder.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { findHealCandidate, healAttachmentPath } from './attachment-heal'

let vaultPath = ''
let dir = ''

function write(name: string, into: string = dir): void {
  fs.mkdirSync(into, { recursive: true })
  fs.writeFileSync(path.join(into, name), 'bytes')
}

beforeEach(() => {
  vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'attachment-heal-'))
  dir = path.join(vaultPath, 'attachments', 'n1')
  fs.mkdirSync(dir, { recursive: true })
})

afterEach(() => {
  fs.rmSync(vaultPath, { recursive: true, force: true })
})

describe('findHealCandidate', () => {
  it('heals a prefix-preserving rename (name part changed)', () => {
    write('abc123-report-final.pdf')

    expect(findHealCandidate(dir, 'abc123-report.pdf')).toBe('abc123-report-final.pdf')
  })

  it('heals a stripped prefix (user removed the nanoid)', () => {
    write('report.pdf')

    expect(findHealCandidate(dir, 'abc123-report.pdf')).toBe('report.pdf')
  })

  it('heals a changed prefix with the name kept', () => {
    write('xyz789-report.pdf')

    expect(findHealCandidate(dir, 'abc123-report.pdf')).toBe('xyz789-report.pdf')
  })

  it('stays broken when the prefix and suffix candidates disagree', () => {
    write('abc123-something-else.pdf')
    write('zzzzzz-report.pdf')

    expect(findHealCandidate(dir, 'abc123-report.pdf')).toBeNull()
  })

  it('stays broken when two files share the prefix', () => {
    write('abc123-a.pdf')
    write('abc123-b.pdf')

    expect(findHealCandidate(dir, 'abc123-report.pdf')).toBeNull()
  })

  it('ignores unrelated files and dotfiles', () => {
    write('abc123-report-v2.pdf')
    write('.DS_Store')
    write('qqqqqq-other.png')

    expect(findHealCandidate(dir, 'abc123-report.pdf')).toBe('abc123-report-v2.pdf')
  })

  it('returns null for an empty or unreadable folder', () => {
    expect(findHealCandidate(dir, 'abc123-report.pdf')).toBeNull()
    expect(findHealCandidate(path.join(dir, 'missing'), 'abc123-report.pdf')).toBeNull()
  })
})

describe('healAttachmentPath', () => {
  it('heals only paths of the attachments/<noteId>/<file> shape inside the vault', () => {
    write('abc123-report-v2.pdf')

    const healed = healAttachmentPath(path.join(dir, 'abc123-report.pdf'), [vaultPath])
    expect(healed).toBe(path.join(dir, 'abc123-report-v2.pdf'))
  })

  it('never matches across notes', () => {
    write('abc123-report.pdf', path.join(vaultPath, 'attachments', 'other-note'))

    expect(healAttachmentPath(path.join(dir, 'abc123-report.pdf'), [vaultPath])).toBeNull()
  })

  it('rejects paths outside an attachments folder', () => {
    const notesDir = path.join(vaultPath, 'notes')
    write('abc123-report-v2.pdf', notesDir)

    expect(healAttachmentPath(path.join(notesDir, 'abc123-report.pdf'), [vaultPath])).toBeNull()
  })

  it('rejects an attachments-shaped path outside the vault', () => {
    const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'foreign-vault-'))
    try {
      const foreignDir = path.join(foreign, 'attachments', 'n1')
      write('abc123-report-v2.pdf', foreignDir)

      expect(healAttachmentPath(path.join(foreignDir, 'abc123-report.pdf'), [vaultPath])).toBeNull()
    } finally {
      fs.rmSync(foreign, { recursive: true, force: true })
    }
  })
})

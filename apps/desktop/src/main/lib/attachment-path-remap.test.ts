import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { remapCrossDeviceAttachmentPath } from './attachment-path-remap'

describe('remapCrossDeviceAttachmentPath', () => {
  let vaultRoot: string

  beforeEach(() => {
    vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-remap-'))
    fs.mkdirSync(path.join(vaultRoot, 'attachments', 'note-1'), { recursive: true })
    fs.writeFileSync(path.join(vaultRoot, 'attachments', 'note-1', 'file.pdf'), 'pdf-bytes')
  })

  afterEach(() => {
    fs.rmSync(vaultRoot, { recursive: true, force: true })
  })

  it('remaps a macOS origin path onto the local vault', () => {
    const requested = '/Users/gengel/Documents/memrynote/attachments/note-1/file.pdf'
    expect(remapCrossDeviceAttachmentPath(requested, [vaultRoot])).toBe(
      path.join(vaultRoot, 'attachments', 'note-1', 'file.pdf')
    )
  })

  it('remaps a Windows origin path (backslashes and drive letter)', () => {
    const requested = 'C:\\Users\\jerry\\vault\\attachments\\note-1\\file.pdf'
    expect(remapCrossDeviceAttachmentPath(requested, [vaultRoot])).toBe(
      path.join(vaultRoot, 'attachments', 'note-1', 'file.pdf')
    )
  })

  it('tries vault roots in order and skips null/undefined entries', () => {
    const requested = '/home/other/vault/attachments/note-1/file.pdf'
    expect(remapCrossDeviceAttachmentPath(requested, [null, undefined, vaultRoot])).toBe(
      path.join(vaultRoot, 'attachments', 'note-1', 'file.pdf')
    )
  })

  it('returns null when the file does not exist locally', () => {
    const requested = '/Users/gengel/Documents/memrynote/attachments/note-1/missing.pdf'
    expect(remapCrossDeviceAttachmentPath(requested, [vaultRoot])).toBeNull()
  })

  it('returns null when the path has no attachments segment', () => {
    const requested = '/Users/gengel/Documents/memrynote/notes/file.pdf'
    expect(remapCrossDeviceAttachmentPath(requested, [vaultRoot])).toBeNull()
  })

  it('rejects traversal segments instead of escaping the attachments dir', () => {
    fs.writeFileSync(path.join(vaultRoot, 'secret.txt'), 'secret')
    const requested = '/Users/gengel/Documents/memrynote/attachments/../secret.txt'
    expect(remapCrossDeviceAttachmentPath(requested, [vaultRoot])).toBeNull()

    const nested = '/x/attachments/note-1/../../secret.txt'
    expect(remapCrossDeviceAttachmentPath(nested, [vaultRoot])).toBeNull()
  })

  it('uses the LAST attachments segment when the vault path itself contains one', () => {
    const requested = '/Users/g/attachments/memrynote/attachments/note-1/file.pdf'
    expect(remapCrossDeviceAttachmentPath(requested, [vaultRoot])).toBe(
      path.join(vaultRoot, 'attachments', 'note-1', 'file.pdf')
    )
  })
})

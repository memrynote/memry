import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import { assertNoRedist, peImports, redistImports } from './pe-imports.mjs'

/** A PE32+ image with one section holding the import and delay-import tables of these DLLs. */
function image(imports, delayImports = []) {
  const buffer = Buffer.alloc(0x600)
  buffer.writeUInt16LE(0x5a4d, 0)
  buffer.writeUInt32LE(0x40, 0x3c)
  buffer.writeUInt32LE(0x4550, 0x40)
  buffer.writeUInt16LE(1, 0x46)
  buffer.writeUInt16LE(240, 0x54)
  const optional = 0x58
  buffer.writeUInt16LE(0x20b, optional)
  buffer.writeUInt32LE(16, optional + 108)
  const section = optional + 240
  const [va, raw] = [0x1000, 0x200]
  buffer.writeUInt32LE(0x400, section + 8)
  buffer.writeUInt32LE(va, section + 12)
  buffer.writeUInt32LE(0x400, section + 16)
  buffer.writeUInt32LE(raw, section + 20)
  const importsAt = 0
  const delayAt = (imports.length + 1) * 20
  let namesAt = delayAt + (delayImports.length + 1) * 32
  const putName = (dll) => {
    buffer.write(`${dll}\0`, raw + namesAt, 'latin1')
    const rva = va + namesAt
    namesAt += dll.length + 1
    return rva
  }
  imports.forEach((dll, i) => buffer.writeUInt32LE(putName(dll), raw + importsAt + i * 20 + 12))
  delayImports.forEach((dll, i) => buffer.writeUInt32LE(putName(dll), raw + delayAt + i * 32 + 4))
  buffer.writeUInt32LE(va + importsAt, optional + 112 + 1 * 8)
  if (delayImports.length > 0) buffer.writeUInt32LE(va + delayAt, optional + 112 + 13 * 8)
  return buffer
}

// The imports of the 2099.101.12 x64 payload's Memrynote.exe (llvm-objdump -p), CRT part.
const HYBRID_CRT = [
  'KERNEL32.dll',
  'api-ms-win-crt-heap-l1-1-0.dll',
  'api-ms-win-crt-runtime-l1-1-0.dll',
  'api-ms-win-crt-stdio-l1-1-0.dll'
]

describe('pe-imports', () => {
  it('reads the import and delay-import tables, lowercased', () => {
    assert.deepEqual(peImports(image(['KERNEL32.dll', 'USER32.dll'], ['dbghelp.dll'])), [
      'kernel32.dll',
      'user32.dll',
      'dbghelp.dll'
    ])
  })

  it('passes an exe that takes its C runtime from Windows', () => {
    assert.deepEqual(redistImports(peImports(image(HYBRID_CRT))), [])
  })

  it('names every import that needs the redistributable, delay-loaded ones too', () => {
    const exe = image(
      [...HYBRID_CRT, 'VCRUNTIME140.dll', 'api-ms-win-crt-newset-l1-1-0.dll'],
      ['MSVCP140.dll']
    )
    assert.deepEqual(redistImports(peImports(exe)), [
      'vcruntime140.dll',
      'api-ms-win-crt-newset-l1-1-0.dll',
      'msvcp140.dll'
    ])
    const dir = mkdtempSync(path.join(os.tmpdir(), 'pe-imports-'))
    writeFileSync(path.join(dir, 'Memrynote.exe'), exe)
    assert.throws(
      () => assertNoRedist(path.join(dir, 'Memrynote.exe')),
      /imports vcruntime140\.dll, api-ms-win-crt-newset-l1-1-0\.dll, msvcp140\.dll: that needs the Visual C\+\+ redistributable/
    )
  })

  it('refuses a file that is not a PE image', () => {
    assert.throws(
      () => peImports(Buffer.from('#!/bin/sh\n'.padEnd(0x80))),
      /not a PE image: no MZ header/
    )
  })
})

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { assertNoRedist, peImports, redistImports } from './pe-imports.mjs'
import { assertPackable } from './vpk-pack.mjs'
import { BOOTSTRAPPER_PATH } from './webview2-bootstrapper.mjs'

/**
 * A PE image with one section holding the import and delay-import tables of these DLLs: PE32+
 * (64-bit, magic 0x20b) by default, PE32 (magic 0x10b) with `pe32`. The two place the data
 * directories at different offsets of the optional header.
 */
function image(imports, delayImports = [], { pe32 = false } = {}) {
  const buffer = Buffer.alloc(0x600)
  buffer.writeUInt16LE(0x5a4d, 0)
  buffer.writeUInt32LE(0x40, 0x3c)
  buffer.writeUInt32LE(0x4550, 0x40)
  buffer.writeUInt16LE(1, 0x46)
  const optionalSize = pe32 ? 224 : 240
  buffer.writeUInt16LE(optionalSize, 0x54)
  const optional = 0x58
  buffer.writeUInt16LE(pe32 ? 0x10b : 0x20b, optional)
  const directories = optional + (pe32 ? 96 : 112)
  buffer.writeUInt32LE(16, directories - 4)
  const section = optional + optionalSize
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
  buffer.writeUInt32LE(va + importsAt, directories + 1 * 8)
  if (delayImports.length > 0) buffer.writeUInt32LE(va + delayAt, directories + 13 * 8)
  return buffer
}

// The imports of the 2099.101.12 x64 payload's Memrynote.exe (llvm-objdump -p), CRT part.
const HYBRID_CRT = [
  'KERNEL32.dll',
  'api-ms-win-crt-heap-l1-1-0.dll',
  'api-ms-win-crt-runtime-l1-1-0.dll',
  'api-ms-win-crt-stdio-l1-1-0.dll'
]

// Every UCRT API set Windows 10 and later ship (learn.microsoft.com, "Universal CRT deployment").
const WINDOWS_UCRT_SETS = [
  'conio',
  'convert',
  'environment',
  'filesystem',
  'heap',
  'locale',
  'math',
  'multibyte',
  'private',
  'process',
  'runtime',
  'stdio',
  'string',
  'time',
  'utility'
].map((set) => `api-ms-win-crt-${set}-l1-1-0.dll`)

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'pe-imports-'))
// A kill for a hung child, not a performance bound: generous for a cold start on a loaded runner.
const SPAWN_TIMEOUT_MS = 60_000

function exeIn(dir, imports) {
  const file = path.join(dir, 'Memrynote.exe')
  writeFileSync(file, image(imports))
  return file
}

describe('pe-imports', () => {
  it('reads the import and delay-import tables, lowercased', () => {
    assert.deepEqual(peImports(image(['KERNEL32.dll', 'USER32.dll'], ['dbghelp.dll'])), [
      'kernel32.dll',
      'user32.dll',
      'dbghelp.dll'
    ])
  })

  it('reads a 32-bit (PE32) image, whose data directories sit 16 bytes earlier', () => {
    assert.deepEqual(
      peImports(image(['KERNEL32.dll', 'VCRUNTIME140.dll'], ['MSVCP140.dll'], { pe32: true })),
      ['kernel32.dll', 'vcruntime140.dll', 'msvcp140.dll']
    )
  })

  it('passes an exe that takes its C runtime from Windows', () => {
    assert.deepEqual(redistImports(peImports(image(HYBRID_CRT))), [])
  })

  it('passes every UCRT API set Windows ships, and flags one it does not', () => {
    assert.deepEqual(redistImports(WINDOWS_UCRT_SETS), [])
    assert.deepEqual(
      redistImports(['api-ms-win-crt-newset-l1-1-0.dll', 'api-ms-win-crt-heap-l1-1-1.dll']),
      ['api-ms-win-crt-newset-l1-1-0.dll', 'api-ms-win-crt-heap-l1-1-1.dll']
    )
  })

  it('flags every DLL of the Visual C++ redistributable', () => {
    const redist = [
      'vcruntime140.dll',
      'vcruntime140_1.dll',
      'vcruntime140d.dll',
      'msvcp140.dll',
      'msvcp140_atomic_wait.dll',
      'msvcp140_codecvt_ids.dll',
      'msvcr100.dll',
      'msvcr120.dll',
      'concrt140.dll',
      'vccorlib140.dll',
      'vcomp140.dll',
      'vcomp140d.dll',
      'vcamp140.dll',
      'mfc140.dll',
      'mfc140u.dll',
      'mfcm140u.dll',
      'ucrtbased.dll'
    ]
    assert.deepEqual(redistImports(redist), redist)
  })

  it('passes the C and C++ runtimes and MFC that are part of Windows', () => {
    const windows = [
      'msvcrt.dll',
      'msvcp_win.dll',
      'msvcp60.dll',
      'mfc42.dll',
      'mfc42u.dll',
      'ucrtbase.dll',
      'api-ms-win-core-synch-l1-2-0.dll'
    ]
    assert.deepEqual(redistImports(windows), [])
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
    const file = path.join(tmp(), 'Memrynote.exe')
    writeFileSync(file, exe)
    assert.throws(
      () => assertNoRedist(file),
      /imports vcruntime140\.dll, api-ms-win-crt-newset-l1-1-0\.dll, msvcp140\.dll: that needs the Visual C\+\+ redistributable/
    )
  })

  it('refuses a file that is not a PE image', () => {
    assert.throws(
      () => peImports(Buffer.from('#!/bin/sh\n'.padEnd(0x80))),
      /not a PE image: no MZ header/
    )
  })

  it('a Windows pack whose exe needs the redistributable is refused', () => {
    const bytes = Buffer.from('MZ pinned bootstrapper bytes')
    const pin = { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }
    const packDir = tmp()
    mkdirSync(path.join(packDir, 'webview2'))
    writeFileSync(path.join(packDir, BOOTSTRAPPER_PATH), bytes)

    exeIn(packDir, [...HYBRID_CRT, 'VCRUNTIME140.dll'])
    for (const target of ['win-x64', 'win-arm64']) {
      assert.throws(() => assertPackable(target, packDir, pin), /imports vcruntime140\.dll/)
    }
    exeIn(packDir, HYBRID_CRT)
    assert.doesNotThrow(() => assertPackable('win-x64', packDir, pin))
  })

  // The CI step and the pack run this file as a program. Started through a symlink, a path
  // comparison against `process.argv[1]` skipped the check and exited 0.
  it('as a program, checks the exe however its path is spelled', (t) => {
    const script = fileURLToPath(new URL('./pe-imports.mjs', import.meta.url))
    const dir = tmp()
    const linked = path.join(dir, 'linked-pe-imports.mjs')
    try {
      symlinkSync(script, linked)
    } catch (error) {
      if (process.platform !== 'win32' || error.code !== 'EPERM') throw error
      t.skip('Windows creates symlinks only in Developer Mode or as admin (EPERM)')
      return
    }
    const redist = exeIn(mkdtempSync(path.join(dir, 'redist-')), ['VCRUNTIME140.dll'])
    const clean = exeIn(mkdtempSync(path.join(dir, 'clean-')), HYBRID_CRT)
    const program = (args) =>
      spawnSync(process.execPath, args, { encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS })

    for (const entry of [script, linked]) {
      const refused = program([entry, redist])
      assert.notEqual(refused.status, 0, `${entry} passed an exe that imports vcruntime140.dll`)
      assert.match(refused.stderr, /imports vcruntime140\.dll/)

      const passed = program([entry, clean])
      assert.equal(passed.status, 0, passed.stderr)
      assert.match(passed.stdout, /no Visual C\+\+ redistributable import/)
    }
    const noExe = program([linked])
    // A child killed by the timeout has status null, which is not 0 either.
    assert.equal(noExe.signal, null, 'pe-imports.mjs was killed, not refused')
    assert.notEqual(noExe.status, 0)
  })
})

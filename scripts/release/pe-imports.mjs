#!/usr/bin/env node
// Fails a Windows exe that needs the Visual C++ redistributable.
// Usage: node scripts/release/pe-imports.mjs <exe>
//
// The Windows packs declare no `vcredist143-*` framework: tauri-build links vcruntime statically
// and the exe takes the C runtime from the UCRT that ships with Windows 10 and later. A Velopack
// Setup started by an old Electron build runs with its dialogs on (`/S` is not its `--silent`), so
// a declared prerequisite the machine lacks stops an unattended migration at a dialog. This check
// turns a dependency that needs the redistributable into a failed pack instead.
import { readFileSync } from 'node:fs'

import { isMain } from './is-main.mjs'

/** The UCRT API sets of Windows 10 and later: `api-ms-win-crt-<name>-l1-1-0.dll`. */
const SYSTEM_UCRT = new Set([
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
])
/**
 * The DLLs of the Visual C++ redistributable: the runtime (`vcruntime140`, `vcruntime140_1`), the
 * C++ library (`msvcp140`, `msvcp140_atomic_wait`), the older CRTs (`msvcr100` to `msvcr120`),
 * ConcRT, C++/CX, OpenMP (`vcomp`), C++ AMP (`vcamp`), MFC (`mfc140u`, `mfcm140`) and the debug
 * UCRT. Windows ships its own `msvcrt.dll`, `msvcp_win.dll`, `msvcp60.dll`, `mfc42.dll` and
 * `ucrtbase.dll`, so a versioned name below 7.0 or without a version is not the redistributable.
 */
const REDIST =
  /^(?:(?:msvcp|msvcr|mfcm?)(?:[7-9]\d|1\d\d)|(?:vcruntime|concrt|vccorlib|vcomp|vcamp)\d|ucrtbased\.dll$)/

const IMPORT_DIRECTORY = 1
const DELAY_IMPORT_DIRECTORY = 13

function fail(why) {
  throw new Error(`not a PE image: ${why}`)
}

/** The DLL names, lowercased, of the import and delay-import tables of the PE image in `image`. */
export function peImports(image) {
  if (image.length < 0x40 || image.readUInt16LE(0) !== 0x5a4d) fail('no MZ header')
  const pe = image.readUInt32LE(0x3c)
  if (pe + 24 > image.length || image.readUInt32LE(pe) !== 0x4550) fail('no PE signature')
  const sections = image.readUInt16LE(pe + 6)
  const optional = pe + 24
  const magic = image.readUInt16LE(optional)
  if (magic !== 0x10b && magic !== 0x20b) fail(`optional header magic ${magic.toString(16)}`)
  const directories = optional + (magic === 0x20b ? 112 : 96)
  const directoryCount = image.readUInt32LE(directories - 4)
  const table = optional + image.readUInt16LE(pe + 20)
  const offset = (rva) => {
    for (let i = 0; i < sections; i++) {
      const header = table + i * 40
      const start = image.readUInt32LE(header + 12)
      const size = Math.max(image.readUInt32LE(header + 8), image.readUInt32LE(header + 16))
      if (rva >= start && rva < start + size) return rva - start + image.readUInt32LE(header + 20)
    }
    return fail(`RVA ${rva.toString(16)} is in no section`)
  }
  const name = (rva) => {
    const at = offset(rva)
    return image.toString('latin1', at, image.indexOf(0, at)).toLowerCase()
  }
  const names = []
  const read = (directory, stride, nameField) => {
    if (directory >= directoryCount) return
    const rva = image.readUInt32LE(directories + directory * 8)
    if (rva === 0) return
    for (let at = offset(rva); ; at += stride) {
      const nameRva = image.readUInt32LE(at + nameField)
      if (nameRva === 0) return
      names.push(name(nameRva))
    }
  }
  read(IMPORT_DIRECTORY, 20, 12)
  read(DELAY_IMPORT_DIRECTORY, 32, 4)
  return names
}

/** The imports of `names` that are not part of Windows: the redistributable and unknown UCRT sets. */
export function redistImports(names) {
  return names.filter((dll) => {
    if (REDIST.test(dll)) return true
    const set = /^api-ms-win-crt-([a-z]+)-l1-1-0\.dll$/.exec(dll)
    return dll.startsWith('api-ms-win-crt-') && !(set && SYSTEM_UCRT.has(set[1]))
  })
}

/** Throws when the exe at `exePath` imports anything from the Visual C++ redistributable. */
export function assertNoRedist(exePath) {
  const found = redistImports(peImports(readFileSync(exePath)))
  if (found.length > 0) {
    throw new Error(
      `${exePath} imports ${found.join(', ')}: that needs the Visual C++ redistributable, which ` +
        'the Windows packs do not install. Link the C runtime statically or drop the dependency.'
    )
  }
}

if (isMain(import.meta)) {
  assertNoRedist(process.argv[2])
  console.log(`${process.argv[2]}: no Visual C++ redistributable import`)
}

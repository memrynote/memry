// Guards the CRDT-store probe in check-native.js.
//
// classic-level is N-API: a binary built for the wrong runtime loads cleanly and
// only dies later, on open or on the first write (#1988, win32). A `require()`
// check therefore reports OK on exactly the broken build it is supposed to
// catch, which is how the missing Electron rebuild shipped. The probe has to be
// a real store round trip, so this test breaks the WRITE — not the load — and
// asserts check-native.js still fails and names the CRDT chain.

const assert = require('node:assert/strict')
const test = require('node:test')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const CHECK_NATIVE = path.join(__dirname, 'check-native.js')

// Preloaded into every process check-native.js spawns (it inherits env). Leaves
// require('y-leveldb') working and only rejects storeUpdate, reproducing the
// "loads fine, dies on write" shape.
const BREAK_WRITE_SHIM = `
const Module = require('node:module')
const load = Module._load
Module._load = function (request, ...rest) {
  const exported = load.call(this, request, ...rest)
  if (request !== 'y-leveldb') return exported
  class BrokenPersistence extends exported.LeveldbPersistence {
    async storeUpdate() {
      throw new Error('simulated classic-level write failure')
    }
  }
  return { ...exported, LeveldbPersistence: BrokenPersistence }
}
`

test('check-native fails when the y-leveldb store round trip cannot write', () => {
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-check-native-test-'))
  const shimPath = path.join(shimDir, 'break-y-leveldb-write.cjs')
  fs.writeFileSync(shimPath, BREAK_WRITE_SHIM)

  try {
    const result = childProcess.spawnSync(process.execPath, [CHECK_NATIVE], {
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: `--require ${shimPath}` }
    })
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n')

    assert.notEqual(result.status, 0, `expected a non-zero exit, got:\n${output}`)
    assert.match(output, /y-leveldb -> classic-level/)
  } finally {
    fs.rmSync(shimDir, { force: true, recursive: true })
  }
})

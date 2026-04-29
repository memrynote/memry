import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { runCodemod } from './codemod-todo-jsx-literals.mjs'

const scriptsRoot = path.dirname(fileURLToPath(import.meta.url))
const fixtureRoot = path.join(scriptsRoot, 'fixtures/codemod')
const input = fs.readFileSync(path.join(fixtureRoot, 'input.tsx'), 'utf8')
const output = fs.readFileSync(path.join(fixtureRoot, 'output.tsx'), 'utf8')

function tempFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-i18n-codemod-'))
  const filePath = path.join(tempDir, 'input.tsx')
  fs.writeFileSync(filePath, input)
  return filePath
}

test('annotates untranslated JSX text and attributes', () => {
  const filePath = tempFixture()
  const result = runCodemod({ paths: [filePath], write: true })

  assert.equal(result.changedFiles.length, 1)
  assert.equal(fs.readFileSync(filePath, 'utf8'), output)
})

test('is idempotent', () => {
  const filePath = tempFixture()
  runCodemod({ paths: [filePath], write: true })
  const result = runCodemod({ paths: [filePath], write: true })

  assert.deepEqual(result.changedFiles, [])
  assert.equal(fs.readFileSync(filePath, 'utf8'), output)
})

test('dry-run reports changed file count without writing', () => {
  const filePath = tempFixture()
  const result = runCodemod({ paths: [filePath], dryRun: true })

  assert.deepEqual(result.changedFiles, [filePath])
  assert.equal(fs.readFileSync(filePath, 'utf8'), input)
})

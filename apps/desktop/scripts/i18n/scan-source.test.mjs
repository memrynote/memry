import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { defaultWorkspaceRoot, loadLocaleResources } from './resources.mjs'
import { scanSourceFiles } from './scan-source.mjs'

const workspaceRoot = defaultWorkspaceRoot()
const fixtureRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/check'
)
const resources = loadLocaleResources(workspaceRoot)

function scanFixture(name) {
  return scanSourceFiles({
    workspaceRoot,
    resources,
    paths: [path.join(fixtureRoot, name)]
  })
}

test('passing fixture reports no failures', () => {
  const result = scanFixture('pass.tsx')

  assert.deepEqual(result.missingKeys, [])
  assert.deepEqual(result.untranslated, [])
  assert.deepEqual(result.unknownNamespaces, [])
})

test('missing key fixture reports a missing English key', () => {
  const result = scanFixture('missing-key.tsx')

  assert.equal(result.missingKeys.length, 1)
  assert.equal(result.missingKeys[0].key, 'notes:missing.phaseEKey')
})

test('untranslated fixture reports text and aria-label', () => {
  const result = scanFixture('untranslated-jsx.tsx')

  assert.equal(result.untranslated.length, 2)
  assert.equal(
    result.untranslated.some((finding) => finding.text === 'Create Note'),
    true
  )
  assert.equal(
    result.untranslated.some(
      (finding) => finding.attributeName === 'aria-label' && finding.text === 'Create note'
    ),
    true
  )
})

test('allowed user content fixture reports no failures', () => {
  const result = scanFixture('allowed-user-content.tsx')

  assert.deepEqual(result.untranslated, [])
})

test('test and spec files are ignored by default', () => {
  const result = scanSourceFiles({
    workspaceRoot,
    resources,
    paths: [
      path.join(fixtureRoot, 'untranslated-jsx.test.tsx'),
      path.join(fixtureRoot, 'untranslated-jsx.spec.tsx')
    ]
  })

  assert.deepEqual(result.files, [])
  assert.deepEqual(result.untranslated, [])
})

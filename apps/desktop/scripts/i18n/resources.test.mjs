import assert from 'node:assert/strict'
import test from 'node:test'
import {
  compareLocaleCompleteness,
  defaultWorkspaceRoot,
  flattenKeys,
  flattenLocale,
  loadLocaleResources
} from './resources.mjs'

test('flattens nested English resources', () => {
  const resources = loadLocaleResources(defaultWorkspaceRoot())
  const englishKeys = flattenLocale(resources.resources.en)

  assert.equal(englishKeys.has('notes:page.empty.title'), true)
  assert.equal(englishKeys.has('common:button.cancel'), true)
})

test('flattens only string leaves', () => {
  assert.deepEqual(flattenKeys('demo', { a: { b: 'B', c: 1 }, d: {} }), ['demo:a.b'])
})

test('classifies missing tr/ar feature keys as warnings', () => {
  const resources = loadLocaleResources(defaultWorkspaceRoot())
  const englishKeys = flattenLocale(resources.resources.en)
  const trKeys = flattenLocale(resources.resources.tr)
  const arKeys = flattenLocale(resources.resources.ar)

  assert.equal(compareLocaleCompleteness({ englishKeys, localeKeys: trKeys }).missing.length > 0, true)
  assert.equal(compareLocaleCompleteness({ englishKeys, localeKeys: arKeys }).missing.length > 0, true)
})

test('accepts empty Phase C namespace resources', () => {
  const resources = loadLocaleResources(defaultWorkspaceRoot())

  assert.deepEqual(resources.resources.tr.notes, {})
  assert.deepEqual(resources.resources.ar.notes, {})
  assert.equal(resources.errors.length, 0)
})

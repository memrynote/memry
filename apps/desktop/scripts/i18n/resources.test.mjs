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

test('classifies missing ar feature keys as warnings while Turkish is complete', () => {
  const resources = loadLocaleResources(defaultWorkspaceRoot())
  const englishKeys = flattenLocale(resources.resources.en)
  const trKeys = flattenLocale(resources.resources.tr)
  const arKeys = flattenLocale(resources.resources.ar)

  assert.equal(compareLocaleCompleteness({ englishKeys, localeKeys: trKeys }).missing.length, 0)
  assert.equal(
    compareLocaleCompleteness({ englishKeys, localeKeys: arKeys }).missing.length > 0,
    true
  )
})

test('accepts populated Turkish resources and empty Arabic Phase C namespace resources', () => {
  const resources = loadLocaleResources(defaultWorkspaceRoot())

  assert.equal(resources.resources.tr.notes.page.empty.title, 'Not seçilmedi')
  assert.deepEqual(resources.resources.ar.notes, {})
  assert.equal(resources.errors.length, 0)
})

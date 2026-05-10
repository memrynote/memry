import assert from 'node:assert/strict'
import test from 'node:test'
import {
  compareLocaleCompleteness,
  defaultWorkspaceRoot,
  flattenKeys,
  flattenLocale,
  loadLocaleResources
} from './resources.mjs'

const expectedLocales = [
  'ar',
  'cs',
  'da',
  'en',
  'de',
  'el',
  'es',
  'fi',
  'fil',
  'fr',
  'he',
  'hr',
  'hu',
  'id',
  'it',
  'ja',
  'ko',
  'ms',
  'nl',
  'no',
  'pl',
  'pt',
  'ro',
  'ru',
  'sk',
  'sv',
  'th',
  'tr',
  'uk',
  'vi',
  'zh-CN',
  'zh-TW'
]

test('flattens nested English resources', () => {
  const resources = loadLocaleResources(defaultWorkspaceRoot())
  const englishKeys = flattenLocale(resources.resources.en)

  assert.equal(englishKeys.has('notes:page.empty.title'), true)
  assert.equal(englishKeys.has('common:button.cancel'), true)
})

test('flattens only string leaves', () => {
  assert.deepEqual(flattenKeys('demo', { a: { b: 'B', c: 1 }, d: {} }), ['demo:a.b'])
})

test('loads exactly the requested locales', () => {
  const resources = loadLocaleResources(defaultWorkspaceRoot())

  assert.deepEqual(resources.locales, expectedLocales)
})

test('all non-English locale resources are complete', () => {
  const resources = loadLocaleResources(defaultWorkspaceRoot())
  const englishKeys = flattenLocale(resources.resources.en)

  for (const locale of resources.locales) {
    if (locale === resources.fallbackLocale) continue

    const localeKeys = flattenLocale(resources.resources[locale])
    const completeness = compareLocaleCompleteness({ englishKeys, localeKeys })

    assert.deepEqual(completeness.missing, [], locale)
    assert.deepEqual(completeness.orphan, [], locale)
  }
})

test('all locale namespace files parse', () => {
  const resources = loadLocaleResources(defaultWorkspaceRoot())

  assert.equal(resources.resources.tr.notes.page.empty.title, 'Not seçilmedi')
  assert.equal(resources.errors.length, 0)
})

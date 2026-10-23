import assert from 'node:assert/strict'
import test from 'node:test'
import plugin from './index.mjs'

test('plugin exports the four i18n rules', () => {
  assert.ok(plugin.rules)
  assert.equal(typeof plugin.rules['no-jsx-text-literals'], 'object')
  assert.equal(typeof plugin.rules['no-string-attribute-literals'], 'object')
  assert.equal(typeof plugin.rules['no-toast-string-literal'], 'object')
  assert.equal(typeof plugin.rules['no-error-fallback-literal'], 'object')
})

test('every rule has a meta.messages map', () => {
  for (const [name, rule] of Object.entries(plugin.rules)) {
    assert.ok(rule.meta, `${name} missing meta`)
    assert.ok(rule.meta.messages, `${name} missing meta.messages`)
    assert.ok(Object.keys(rule.meta.messages).length > 0, `${name} has empty meta.messages`)
  }
})

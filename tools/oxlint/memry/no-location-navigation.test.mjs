import { describe, it } from 'node:test'
import { RuleTester } from 'oxlint/plugins-dev'
import plugin from './index.mjs'

RuleTester.describe = describe
RuleTester.it = it

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: 'ts' } } })

tester.run('no-location-navigation', plugin.rules['no-location-navigation'], {
  valid: [
    'location.reload()',
    'window.location.reload()',
    'const href = location.href',
    'const location = locateBlock(doc, id)',
    'route.location = next',
    'void commands.shellOpenExternal(url)'
  ],
  invalid: [
    'location.assign(url)',
    'window.location.assign(url)',
    'location.replace(url)',
    'document.location.replace(url)',
    'location.href = url',
    'window.location.href = url',
    'window.location = url',
    'document.location = url',
    'top.location = url'
  ].map((code) => ({ code, errors: [{ messageId: 'navigates' }] }))
})

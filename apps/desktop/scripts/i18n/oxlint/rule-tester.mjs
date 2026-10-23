import { describe, it } from 'node:test'
import { RuleTester } from 'oxlint/plugins-dev'

RuleTester.describe = describe
RuleTester.it = it

export function createRuleTester({ jsx = false } = {}) {
  return new RuleTester({
    eslintCompat: true,
    languageOptions: { parserOptions: { lang: jsx ? 'tsx' : 'ts' } }
  })
}

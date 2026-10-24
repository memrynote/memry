import { describe, it } from 'node:test'
import { RuleTester } from 'oxlint/plugins-dev'

// oxlint-disable-next-line typescript/no-misused-promises -- node:test's describe/it return promises that RuleTester ignores
RuleTester.describe = describe
// oxlint-disable-next-line typescript/no-misused-promises -- node:test's describe/it return promises that RuleTester ignores
RuleTester.it = it

export function createRuleTester({ jsx = false } = {}) {
  return new RuleTester({
    eslintCompat: true,
    languageOptions: { parserOptions: { lang: jsx ? 'tsx' : 'ts' } }
  })
}

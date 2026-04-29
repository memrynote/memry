import { RuleTester } from 'eslint'
import test from 'node:test'
import tsParser from '@typescript-eslint/parser'
import rule from './no-error-fallback-literal.mjs'

const tester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: { ecmaVersion: 'latest', sourceType: 'module' }
  }
})

test('no-error-fallback-literal', () => {
  tester.run('no-error-fallback-literal', rule, {
    valid: [
      { code: "extractErrorMessage(err, t('common:toast.actionFailed'))" },
      { code: 'extractErrorMessage(err)' },
      { code: 'extractErrorMessage(err, fallback)' },
      {
        code: `// TODO(i18n): wrap fallback in t()
extractErrorMessage(err, 'Failed')`
      },
      { code: "throw new Error('Unauthorized')" },
      { code: "throw new Error('Failed to load the file')" },
      { code: 'throw new Error(message)' }
    ],
    invalid: [
      {
        code: "extractErrorMessage(err, 'Failed to save')",
        errors: [{ messageId: 'extractFallback' }]
      },
      {
        code: "extractErrorMessage(err, 'Action failed')",
        errors: [{ messageId: 'extractFallback' }]
      },
      {
        code: 'extractErrorMessage(err, `Could not save`)',
        errors: [{ messageId: 'extractFallback' }]
      }
    ]
  })
})

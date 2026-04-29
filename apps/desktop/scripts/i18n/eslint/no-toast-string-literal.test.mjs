import { RuleTester } from 'eslint'
import test from 'node:test'
import tsParser from '@typescript-eslint/parser'
import rule from './no-toast-string-literal.mjs'

const tester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: { ecmaVersion: 'latest', sourceType: 'module' }
  }
})

test('no-toast-string-literal', () => {
  tester.run('no-toast-string-literal', rule, {
    valid: [
      { code: "toast.success(t('common:toast.copied'))" },
      { code: "toast.error(t('notes:page.toast.saveFailed'))" },
      { code: 'toast.info(message)' },
      { code: 'toast.success(`${greeting}, ${name}`)' },
      { code: 'someOtherFn.success("ignored")' },
      {
        code: `// TODO(i18n): wrap toast in t()
toast.error('Failed to save')`
      },
      { code: 'toast(getMessage())' }
    ],
    invalid: [
      {
        code: 'toast.success("Saved")',
        errors: [{ messageId: 'toastLiteral' }]
      },
      {
        code: 'toast.error("Failed to save")',
        errors: [{ messageId: 'toastLiteral' }]
      },
      {
        code: 'toast.info(`Loading data`)',
        errors: [{ messageId: 'toastLiteral' }]
      },
      {
        code: 'toast("Welcome")',
        errors: [{ messageId: 'toastLiteral' }]
      }
    ]
  })
})

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
      // Interpolation of already-translated parts: every letter comes out of t(),
      // the quasis hold nothing but punctuation and spacing.
      { code: "toast.info(t('inbox:toast.snoozed', { count }))" },
      { code: "toast.error(`${t('common:saveFailed')}: ${err.message}`)" },
      { code: "toast.success(`${t('notes:created')} ${t('notes:openHint')}`)" },
      { code: 'someOtherFn.success("ignored")' },
      {
        code: `// TODO(i18n): wrap toast in t()
toast.error('Failed to save')`
      },
      {
        code: `// TODO(i18n): wrap toast in t()
toast.error(\`Could not open \${name}\`)`
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
      },
      // Interpolation is a formatting detail, not evidence of translation: the
      // English sitting between the holes is exactly as hard-coded as a plain literal.
      {
        code: 'toast.info(`${count} items snoozed`)',
        errors: [{ messageId: 'toastLiteral' }]
      },
      {
        code: 'toast.error(`Could not open ${name}`)',
        errors: [{ messageId: 'toastLiteral' }]
      },
      {
        code: 'toast.success(`Imported ${n} file${n > 1 ? "s" : ""}`)',
        errors: [{ messageId: 'toastLiteral' }]
      },
      {
        code: 'toast(`Welcome back, ${name}`)',
        errors: [{ messageId: 'toastLiteral' }]
      }
    ]
  })
})

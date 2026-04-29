import { RuleTester } from 'eslint'
import test from 'node:test'
import tsParser from '@typescript-eslint/parser'
import rule from './no-string-attribute-literals.mjs'

const tester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: {
      ecmaFeatures: { jsx: true },
      ecmaVersion: 'latest',
      sourceType: 'module'
    }
  }
})

test('no-string-attribute-literals', () => {
  tester.run('no-string-attribute-literals', rule, {
    valid: [
      { code: "const x = <input placeholder={t('search.placeholder')} />" },
      { code: 'const x = <input className="search" />' },
      { code: 'const x = <input data-testid="search" />' },
      { code: 'const x = <div role="button" />' },
      { code: 'const x = <input placeholder="" />' },
      { code: 'const x = <span aria-label="—" />' },
      { code: 'const x = <span aria-label="…" />' },
      { code: 'const x = <span aria-label="100%" />' },
      {
        code: `// TODO(i18n): wrap placeholder in t()
const x = <input placeholder="Search..." />`
      },
      { code: 'const x = <input disabled />' }
    ],
    invalid: [
      {
        code: 'const x = <input placeholder="Search..." />',
        errors: [{ messageId: 'stringAttributeLiteral' }]
      },
      {
        code: 'const x = <button aria-label="Close" />',
        errors: [{ messageId: 'stringAttributeLiteral' }]
      },
      {
        code: 'const x = <button title="Save" />',
        errors: [{ messageId: 'stringAttributeLiteral' }]
      },
      {
        code: 'const x = <Component label="Hello world" />',
        errors: [{ messageId: 'stringAttributeLiteral' }]
      },
      {
        code: 'const x = <Component subtitle={"Loading..."} />',
        errors: [{ messageId: 'stringAttributeLiteral' }]
      }
    ]
  })
})

import { RuleTester } from 'eslint'
import test from 'node:test'
import tsParser from '@typescript-eslint/parser'
import rule from './no-jsx-text-literals.mjs'

const tester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: {
      ecmaFeatures: {
        jsx: true
      },
      ecmaVersion: 'latest',
      sourceType: 'module'
    }
  }
})

test('no-jsx-text-literals', () => {
  tester.run('no-jsx-text-literals', rule, {
    valid: [
      {
        code: `
          const { t } = useT('notes')
          export function A() {
            return <h1>{t('page.empty.title')}</h1>
          }
        `
      },
      {
        code: `
          export function B({ title }: { title: string }) {
            return <h1>{title}</h1>
          }
        `
      },
      {
        code: `
          export function C() {
            return (
              <button>
                {/* TODO(i18n): wrap in t() */}
                Create Note
              </button>
            )
          }
        `
      },
      {
        code: `
          export function D() {
            return <kbd>N</kbd>
          }
        `
      }
    ],
    invalid: [
      {
        code: `
          export function A() {
            return <h1>Create Note</h1>
          }
        `,
        errors: [{ messageId: 'jsxTextLiteral' }]
      },
      {
        code: `
          export function B() {
            return <><span>Loading...</span><span>Failed</span></>
          }
        `,
        errors: [{ messageId: 'jsxTextLiteral' }, { messageId: 'jsxTextLiteral' }]
      }
    ]
  })
})

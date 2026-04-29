import noJsxTextLiterals from './no-jsx-text-literals.mjs'
import noStringAttributeLiterals from './no-string-attribute-literals.mjs'
import noToastStringLiteral from './no-toast-string-literal.mjs'
import noErrorFallbackLiteral from './no-error-fallback-literal.mjs'

export default {
  rules: {
    'no-jsx-text-literals': noJsxTextLiterals,
    'no-string-attribute-literals': noStringAttributeLiterals,
    'no-toast-string-literal': noToastStringLiteral,
    'no-error-fallback-literal': noErrorFallbackLiteral
  }
}

const TODO_RE = /TODO\(i18n\):\s*wrap(?:\s+[\w-]+)?\s+in\s+t\(\)/i

function hasLetters(value) {
  return /[A-Za-z]/.test(value)
}

function getStringValue(arg) {
  if (!arg) return null
  if (arg.type === 'Literal' && typeof arg.value === 'string') {
    return arg.value
  }
  if (arg.type === 'TemplateLiteral' && arg.expressions.length === 0) {
    return arg.quasis.map((q) => q.value.cooked).join('')
  }
  return null
}

function hasI18nTodoNear(sourceCode, node) {
  const line = node.loc.start.line
  const sameLine = sourceCode.lines[line - 1] ?? ''
  const previousLine = sourceCode.lines[line - 2] ?? ''
  return TODO_RE.test(sameLine) || TODO_RE.test(previousLine)
}

function isExtractErrorMessageCall(node) {
  return (
    node.callee?.type === 'Identifier' &&
    node.callee.name === 'extractErrorMessage'
  )
}

function isThrowNewError(node) {
  return (
    node.type === 'NewExpression' &&
    node.callee?.type === 'Identifier' &&
    node.callee.name === 'Error'
  )
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow string-literal fallbacks in extractErrorMessage and user-facing throw new Error'
    },
    messages: {
      extractFallback:
        "extractErrorMessage fallback is a literal English string; use t('namespace:key') or annotate with TODO(i18n).",
      throwLiteral:
        "throw new Error has a literal English message; use t('errors:key') or annotate with TODO(i18n) (or single-word internal errors are exempt)."
    },
    schema: []
  },
  create(context) {
    const sourceCode = context.sourceCode

    return {
      CallExpression(node) {
        if (!isExtractErrorMessageCall(node)) return
        const fallback = node.arguments?.[1]
        const value = getStringValue(fallback)
        if (value === null || !hasLetters(value)) return
        if (hasI18nTodoNear(sourceCode, node)) return
        context.report({
          node: fallback,
          messageId: 'extractFallback'
        })
      },
      NewExpression(node) {
        if (!isThrowNewError(node)) return
        const arg = node.arguments?.[0]
        const value = getStringValue(arg)
        if (value === null || !hasLetters(value)) return
        const wordCount = value.trim().split(/\s+/).length
        if (wordCount < 2) return
        if (hasI18nTodoNear(sourceCode, node)) return
        context.report({
          node: arg,
          messageId: 'throwLiteral'
        })
      }
    }
  }
}

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

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow string-literal fallbacks in extractErrorMessage'
    },
    messages: {
      extractFallback:
        "extractErrorMessage fallback is a literal English string; use t('namespace:key') or annotate with TODO(i18n)."
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
      }
    }
  }
}

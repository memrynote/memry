const TOAST_METHODS = new Set([
  'success',
  'error',
  'info',
  'warning',
  'loading',
  'message',
  'promise'
])

const TODO_RE = /TODO\(i18n\):\s*wrap(?:\s+[\w-]+)?\s+in\s+t\(\)/i

function hasLetters(value) {
  return /[A-Za-z]/.test(value)
}

function isToastCall(node) {
  if (node.callee?.type === 'Identifier' && node.callee.name === 'toast') {
    return true
  }
  if (
    node.callee?.type === 'MemberExpression' &&
    node.callee.object?.type === 'Identifier' &&
    node.callee.object.name === 'toast' &&
    node.callee.property?.type === 'Identifier' &&
    TOAST_METHODS.has(node.callee.property.name)
  ) {
    return true
  }
  return false
}

function isStringLiteralWithLetters(arg) {
  if (!arg) return false
  if (arg.type === 'Literal' && typeof arg.value === 'string') {
    return hasLetters(arg.value)
  }
  if (arg.type === 'TemplateLiteral') {
    // Only the static text counts. A template assembled purely from translated
    // parts (`${t('a')} ${t('b')}`) leaves nothing but punctuation/whitespace in
    // the quasis, so it stays valid; hard-coded English between the holes does not.
    const raw = arg.quasis.map((q) => q.value.cooked).join('')
    return hasLetters(raw)
  }
  return false
}

function hasI18nTodoNear(sourceCode, node) {
  const line = node.loc.start.line
  const sameLine = sourceCode.lines[line - 1] ?? ''
  const previousLine = sourceCode.lines[line - 2] ?? ''
  return TODO_RE.test(sameLine) || TODO_RE.test(previousLine)
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow string-literal first arguments in toast.* calls'
    },
    messages: {
      toastLiteral:
        "toast call has a literal English first argument; use t('namespace:key') or annotate with TODO(i18n)."
    },
    schema: []
  },
  create(context) {
    const sourceCode = context.sourceCode

    return {
      CallExpression(node) {
        if (!isToastCall(node)) return
        const firstArg = node.arguments?.[0]
        if (!isStringLiteralWithLetters(firstArg)) return
        if (hasI18nTodoNear(sourceCode, node)) return

        context.report({
          node: firstArg,
          messageId: 'toastLiteral'
        })
      }
    }
  }
}

const IGNORED_TAGS = new Set(['kbd', 'code', 'pre', 'script', 'style'])
const TODO_RE = /TODO\(i18n\):\s*wrap(?:\s+[\w-]+)?\s+in\s+t\(\)/i

function hasLetters(value) {
  return /[A-Za-z]/.test(value)
}

function collapseWhitespace(value) {
  return value.replace(/\s+/g, ' ').trim()
}

function getJsxName(name) {
  if (!name) return null
  if (name.type === 'JSXIdentifier') return name.name
  if (name.type === 'JSXMemberExpression') return getJsxName(name.property)
  return null
}

function hasAncestorTag(node, tagName) {
  let current = node.parent
  while (current) {
    if (current.type === 'JSXElement' && getJsxName(current.openingElement?.name) === tagName) {
      return true
    }
    current = current.parent
  }
  return false
}

function shouldIgnoreText(node) {
  const parent = node.parent
  const tagName = parent?.type === 'JSXElement' ? getJsxName(parent.openingElement?.name) : null

  if (tagName && IGNORED_TAGS.has(tagName)) return true
  return tagName === 'title' && hasAncestorTag(parent, 'svg')
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
      description: 'Disallow unannotated JSX text literals'
    },
    messages: {
      jsxTextLiteral: 'JSX text literal must use t() or be marked with TODO(i18n).'
    },
    schema: []
  },
  create(context) {
    const sourceCode = context.sourceCode

    return {
      JSXText(node) {
        const text = collapseWhitespace(node.value)
        if (!text || !hasLetters(text) || shouldIgnoreText(node)) return
        if (hasI18nTodoNear(sourceCode, node)) return

        context.report({
          node,
          messageId: 'jsxTextLiteral'
        })
      }
    }
  }
}

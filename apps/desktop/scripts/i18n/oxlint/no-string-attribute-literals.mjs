const TRANSLATABLE_ATTRIBUTES = new Set([
  'placeholder',
  'aria-label',
  'aria-description',
  'aria-roledescription',
  'title',
  'tooltip',
  'subtitle',
  'label',
  'description',
  'helperText',
  'caption',
  'alt',
  'message',
  'summary'
])

const NON_TRANSLATABLE_ATTRIBUTES_OVERRIDE = new Set([])

const TODO_RE = /TODO\(i18n\):\s*wrap(?:\s+[\w-]+)?\s+in\s+t\(\)/i

function hasLetters(value) {
  return /[A-Za-z]/.test(value)
}

function getJsxName(name) {
  if (!name) return null
  if (name.type === 'JSXIdentifier') return name.name
  if (name.type === 'JSXNamespacedName') return `${name.namespace.name}:${name.name.name}`
  if (name.type === 'JSXMemberExpression') return getJsxName(name.property)
  return null
}

function getAttributeName(attr) {
  if (!attr || attr.type !== 'JSXAttribute') return null
  return getJsxName(attr.name)
}

function isAttrIgnored(attrName) {
  if (!attrName) return true
  if (!TRANSLATABLE_ATTRIBUTES.has(attrName)) return true
  if (NON_TRANSLATABLE_ATTRIBUTES_OVERRIDE.has(attrName)) return true
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
      description: 'Disallow user-facing string-literal values in JSX attributes'
    },
    messages: {
      stringAttributeLiteral:
        "JSX attribute '{{attr}}' has a literal English value; use t('namespace:key') or annotate with TODO(i18n)."
    },
    schema: []
  },
  create(context) {
    const sourceCode = context.sourceCode

    return {
      JSXAttribute(node) {
        const attrName = getAttributeName(node)
        if (isAttrIgnored(attrName)) return

        const value = node.value
        if (!value) return

        if (value.type === 'Literal' && typeof value.value === 'string') {
          if (!hasLetters(value.value)) return
          if (hasI18nTodoNear(sourceCode, node)) return
          context.report({
            node: value,
            messageId: 'stringAttributeLiteral',
            data: { attr: attrName }
          })
          return
        }

        if (
          value.type === 'JSXExpressionContainer' &&
          value.expression?.type === 'Literal' &&
          typeof value.expression.value === 'string'
        ) {
          if (!hasLetters(value.expression.value)) return
          if (hasI18nTodoNear(sourceCode, node)) return
          context.report({
            node: value.expression,
            messageId: 'stringAttributeLiteral',
            data: { attr: attrName }
          })
        }
      }
    }
  }
}

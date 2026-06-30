import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import {
  FALLBACK_LOCALE,
  defaultWorkspaceRoot,
  flattenLocale,
  loadLocaleResources
} from './resources.mjs'

const DEFAULT_SCAN_PATHS = ['apps/desktop/src/renderer/src', 'apps/desktop/src/main']
const USER_FACING_ATTRIBUTES = new Set(['aria-label', 'title', 'placeholder', 'alt'])
const USER_FACING_PROPS = new Set(['label', 'description', 'emptyText', 'tooltip', 'message'])
const TECHNICAL_ATTRIBUTES = new Set([
  'data-testid',
  'id',
  'className',
  'role',
  'type',
  'value',
  'key'
])
const IGNORED_TEXT_TAGS = new Set([
  'code',
  'pre',
  'kbd',
  'script',
  'style',
  'ContextMenuShortcut',
  'DropdownMenuShortcut'
])
const TODO_RE = /TODO\(i18n\):\s*wrap(?:\s+[\w-]+)?\s+in\s+t\(\)/i

function normalizePath(filePath) {
  return filePath.split(path.sep).join('/')
}

function relativePath(workspaceRoot, filePath) {
  return normalizePath(path.relative(workspaceRoot, filePath))
}

function isSourceFile(filePath) {
  return /\.(tsx?|jsx?)$/.test(filePath)
}

export function isIgnoredSourcePath(filePath, workspaceRoot = defaultWorkspaceRoot()) {
  const rel = normalizePath(
    path.isAbsolute(filePath) ? path.relative(workspaceRoot, filePath) : filePath
  )

  return (
    rel.includes('/node_modules/') ||
    rel.includes('/dist/') ||
    rel.includes('/out/') ||
    rel.includes('/build/') ||
    rel.startsWith('apps/desktop/tests/') ||
    /\.(test|spec)\.tsx?$/.test(rel) ||
    /\.d\.ts$/.test(rel)
  )
}

function collectSourceFiles(inputPath, workspaceRoot, files) {
  const absolutePath = path.isAbsolute(inputPath) ? inputPath : path.join(workspaceRoot, inputPath)

  if (!fs.existsSync(absolutePath)) return

  const stat = fs.statSync(absolutePath)
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(absolutePath)) {
      collectSourceFiles(path.join(absolutePath, entry), workspaceRoot, files)
    }
    return
  }

  if (
    stat.isFile() &&
    isSourceFile(absolutePath) &&
    !isIgnoredSourcePath(absolutePath, workspaceRoot)
  ) {
    files.push(absolutePath)
  }
}

export function resolveSourceFiles(
  paths = DEFAULT_SCAN_PATHS,
  workspaceRoot = defaultWorkspaceRoot()
) {
  const files = []
  for (const inputPath of paths.length === 0 ? DEFAULT_SCAN_PATHS : paths) {
    collectSourceFiles(inputPath, workspaceRoot, files)
  }
  return [...new Set(files)].sort()
}

function getLineAndColumn(sourceFile, position) {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(position)
  return {
    line: line + 1,
    column: character + 1
  }
}

function hasLetters(value) {
  return /[A-Za-z]/.test(value)
}

function collapseWhitespace(value) {
  return value.replace(/\s+/g, ' ').trim()
}

function hasI18nTodoNear(sourceText, line) {
  const lines = sourceText.split(/\r?\n/)
  const sameLine = lines[line - 1] ?? ''
  const previousLine = lines[line - 2] ?? ''
  return TODO_RE.test(sameLine) || TODO_RE.test(previousLine)
}

function stringLiteralValue(node) {
  if (!node) return null
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  return null
}

function looksLikeResourcePath(value) {
  return value.includes('.') || value.includes(':')
}

function collectLiteralTranslationKeys(sourceFile, englishKeys, namespaces) {
  const keys = new Set()

  function addLiteral(value) {
    if (!value || !looksLikeResourcePath(value)) return

    if (englishKeys.has(value)) {
      keys.add(value)
    }

    if (!value.includes(':')) {
      for (const namespace of namespaces) {
        const fullKey = `${namespace}:${value}`
        if (englishKeys.has(fullKey)) keys.add(fullKey)
      }
    }
  }

  function visit(node) {
    const value = stringLiteralValue(node)
    if (value) addLiteral(value)
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return keys
}

function getPropertyNameText(name) {
  if (!name) return null
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text
  return null
}

function getJsxTagName(tagName) {
  if (!tagName) return null
  if (ts.isIdentifier(tagName)) return tagName.text
  if (ts.isPropertyAccessExpression(tagName)) return tagName.name.text
  return null
}

function getParentJsxElement(node) {
  let current = node.parent
  while (current) {
    if (ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current)) return current
    current = current.parent
  }
  return null
}

function getOpeningElement(node) {
  if (ts.isJsxElement(node)) return node.openingElement
  if (ts.isJsxSelfClosingElement(node)) return node
  return null
}

function hasAncestorTag(node, tagName) {
  let current = node.parent
  while (current) {
    if (ts.isJsxElement(current) && getJsxTagName(current.openingElement.tagName) === tagName)
      return true
    if (ts.isJsxSelfClosingElement(current) && getJsxTagName(current.tagName) === tagName)
      return true
    current = current.parent
  }
  return false
}

function shouldIgnoreJsxText(node) {
  const parentElement = getParentJsxElement(node)
  const opening = parentElement ? getOpeningElement(parentElement) : null
  const tagName = opening ? getJsxTagName(opening.tagName) : null

  if (tagName && IGNORED_TEXT_TAGS.has(tagName)) return true
  if (parentElement && isShortcutDisplayElement(parentElement)) return true
  return tagName === 'title' && hasAncestorTag(parentElement ?? node, 'svg')
}

function collectJsxLiteralText(node) {
  if (ts.isJsxText(node)) return node.getText()
  if (ts.isJsxExpression(node)) return ''
  if (ts.isJsxElement(node)) return node.children.map(collectJsxLiteralText).join('')
  return ''
}

function isShortcutDisplayElement(node) {
  if (!ts.isJsxElement(node)) return false
  const text = collapseWhitespace(collectJsxLiteralText(node))
  return /[⌘⇧⌥↵←→↑↓\\]/.test(text) && /^[⌘⇧⌥↵←→↑↓\\A-Za-z0-9+\s,.-]+$/.test(text)
}

function isCodeExampleAttribute(attributeName, value) {
  if (attributeName !== 'placeholder') return false
  return /^[a-z][\w.]*\(.*\)$/.test(value) || /^[a-z][a-z0-9_]*$/i.test(value)
}

function findTextInsertion(sourceFile, node) {
  const text = sourceFile.text.slice(node.getFullStart(), node.getEnd())
  const match = /[A-Za-z]/.exec(text)
  const position = node.getFullStart() + (match?.index ?? 0)
  return {
    position,
    ...getLineAndColumn(sourceFile, position)
  }
}

function isUseTCall(node) {
  return (
    !!node &&
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'useT'
  )
}

function isGetFixedTCall(node) {
  return (
    !!node &&
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'getFixedT'
  )
}

function namespaceFromGetFixedT(node) {
  if (!isGetFixedTCall(node)) return null
  return stringLiteralValue(node.arguments[1])
}

function bindUseTDeclaration(node, tBindings) {
  if (!ts.isVariableDeclaration(node) || !isUseTCall(node.initializer)) return

  const namespace = stringLiteralValue(node.initializer.arguments[0])
  if (!namespace || !ts.isObjectBindingPattern(node.name)) return

  for (const element of node.name.elements) {
    const propertyName = getPropertyNameText(element.propertyName ?? element.name)
    if (propertyName !== 't' || !ts.isIdentifier(element.name)) continue
    tBindings.set(element.name.text, namespace)
  }
}

function bindGetFixedTDeclaration(node, tBindings) {
  if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return

  const namespace = namespaceFromGetFixedT(node.initializer)
  if (!namespace) return

  tBindings.set(node.name.text, namespace)
}

function getTranslationCall(node, tBindings) {
  if (!ts.isCallExpression(node)) return null

  if (ts.isIdentifier(node.expression) && tBindings.has(node.expression.text)) {
    return {
      namespace: tBindings.get(node.expression.text),
      keyNode: node.arguments[0],
      call: node
    }
  }

  if (
    ts.isIdentifier(node.expression) &&
    node.expression.text === 't' &&
    ts.isTemplateExpression(node.arguments[0])
  ) {
    return {
      namespace: null,
      keyNode: node.arguments[0],
      call: node
    }
  }

  if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 't') {
    return {
      namespace: null,
      keyNode: node.arguments[0],
      call: node
    }
  }

  if (ts.isCallExpression(node.expression)) {
    const namespace = namespaceFromGetFixedT(node.expression)
    if (namespace) {
      return {
        namespace,
        keyNode: node.arguments[0],
        call: node
      }
    }
  }

  return null
}

function resolveTranslationKey(rawKey, boundNamespace) {
  const colonIndex = rawKey.indexOf(':')
  if (colonIndex >= 0) {
    return {
      namespace: rawKey.slice(0, colonIndex),
      key: rawKey.slice(colonIndex + 1),
      fullKey: rawKey
    }
  }

  const namespace = boundNamespace ?? 'common'
  return {
    namespace,
    key: rawKey,
    fullKey: `${namespace}:${rawKey}`
  }
}

function expandDynamicTranslationKeys(keyNode, boundNamespace, englishKeys) {
  if (!keyNode || !ts.isTemplateExpression(keyNode)) return []

  const rawPrefix = keyNode.head.text
  const rawSuffix = keyNode.templateSpans.at(-1)?.literal.text ?? ''

  if (!rawPrefix && !rawSuffix) return []

  const fullPrefixes =
    rawPrefix.includes(':') || boundNamespace
      ? [rawPrefix.includes(':') ? rawPrefix : `${boundNamespace}:${rawPrefix}`]
      : [...new Set([...englishKeys].map((key) => key.slice(0, key.indexOf(':') + 1)))].map(
          (namespacePrefix) => `${namespacePrefix}${rawPrefix}`
        )

  return [...englishKeys]
    .filter(
      (key) => fullPrefixes.some((prefix) => key.startsWith(prefix)) && key.endsWith(rawSuffix)
    )
    .sort()
}

function createFinding(sourceFile, workspaceRoot, filePath, node, type, extras = {}) {
  return {
    type,
    file: relativePath(workspaceRoot, filePath),
    ...getLineAndColumn(sourceFile, node.getStart(sourceFile)),
    ...extras
  }
}

export function scanFile(filePath, options = {}) {
  const workspaceRoot = options.workspaceRoot ?? defaultWorkspaceRoot()
  const resources = options.resources ?? loadLocaleResources(workspaceRoot)
  const namespaces = new Set(resources.namespaces)
  const englishKeys = options.englishKeys ?? flattenLocale(resources.resources[FALLBACK_LOCALE])
  const sourceText = fs.readFileSync(filePath, 'utf8')
  const sourceKind = filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    sourceKind
  )
  const tBindings = new Map()
  const usedKeys = new Set()
  const missingKeys = []
  const unknownNamespaces = []
  const dynamicKeyWarnings = []
  const untranslated = []
  const todoFindings = []

  for (const key of collectLiteralTranslationKeys(sourceFile, englishKeys, namespaces)) {
    usedKeys.add(key)
  }

  function recordTranslationCall(node, translationCall) {
    const rawKey = stringLiteralValue(translationCall.keyNode)
    if (!rawKey) {
      for (const key of expandDynamicTranslationKeys(
        translationCall.keyNode,
        translationCall.namespace,
        englishKeys
      )) {
        usedKeys.add(key)
      }
      return
    }

    const resolved = resolveTranslationKey(rawKey, translationCall.namespace)
    usedKeys.add(resolved.fullKey)

    if (!namespaces.has(resolved.namespace)) {
      unknownNamespaces.push(
        createFinding(
          sourceFile,
          workspaceRoot,
          filePath,
          translationCall.keyNode,
          'unknown-namespace',
          {
            namespace: resolved.namespace,
            key: resolved.fullKey
          }
        )
      )
      return
    }

    if (!englishKeys.has(resolved.fullKey)) {
      missingKeys.push(
        createFinding(sourceFile, workspaceRoot, filePath, translationCall.keyNode, 'missing-key', {
          namespace: resolved.namespace,
          key: resolved.fullKey
        })
      )
    }
  }

  function recordUntranslated(node, text, extras = {}) {
    const location = extras.location ?? getLineAndColumn(sourceFile, node.getStart(sourceFile))
    const finding = {
      type: extras.type ?? 'untranslated-jsx-text',
      file: relativePath(workspaceRoot, filePath),
      line: location.line,
      column: location.column,
      text,
      ...extras
    }
    delete finding.location

    if (hasI18nTodoNear(sourceText, finding.line)) {
      todoFindings.push({
        ...finding,
        todoAnnotated: true
      })
      return
    }

    untranslated.push(finding)
  }

  function visit(node) {
    bindUseTDeclaration(node, tBindings)
    bindGetFixedTDeclaration(node, tBindings)

    const translationCall = getTranslationCall(node, tBindings)
    if (translationCall) recordTranslationCall(node, translationCall)

    if (ts.isJsxText(node) && !shouldIgnoreJsxText(node)) {
      const text = collapseWhitespace(node.getText(sourceFile))
      if (text && hasLetters(text)) {
        const location = findTextInsertion(sourceFile, node)
        recordUntranslated(node, text, {
          type: 'untranslated-jsx-text',
          location,
          insert: {
            kind: 'jsx-text',
            position: location.position
          }
        })
      }
    }

    if (ts.isJsxAttribute(node)) {
      const attributeName = node.name.text
      const isUserFacing =
        USER_FACING_ATTRIBUTES.has(attributeName) || USER_FACING_PROPS.has(attributeName)

      if (
        isUserFacing &&
        !TECHNICAL_ATTRIBUTES.has(attributeName) &&
        node.initializer &&
        ts.isStringLiteral(node.initializer) &&
        hasLetters(node.initializer.text) &&
        !isCodeExampleAttribute(attributeName, node.initializer.text)
      ) {
        const location = getLineAndColumn(sourceFile, node.initializer.getStart(sourceFile))
        recordUntranslated(node, node.initializer.text, {
          type: 'untranslated-jsx-attribute',
          attributeName,
          location,
          insert: {
            kind: 'jsx-attribute',
            start: node.initializer.getStart(sourceFile),
            end: node.initializer.getEnd()
          }
        })
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)

  const todoCommentCount = [...sourceText.matchAll(new RegExp(TODO_RE.source, 'gi'))].length

  return {
    file: relativePath(workspaceRoot, filePath),
    usedKeys,
    missingKeys,
    unknownNamespaces,
    dynamicKeyWarnings,
    untranslated,
    todoFindings,
    todoCommentCount
  }
}

export function scanSourceFiles(options = {}) {
  const workspaceRoot = options.workspaceRoot ?? defaultWorkspaceRoot()
  const resources = options.resources ?? loadLocaleResources(workspaceRoot)
  const englishKeys = flattenLocale(resources.resources[FALLBACK_LOCALE])
  const files = resolveSourceFiles(options.paths ?? DEFAULT_SCAN_PATHS, workspaceRoot)
  const usedKeys = new Set()
  const missingKeys = []
  const unknownNamespaces = []
  const dynamicKeyWarnings = []
  const untranslated = []
  const todoFindings = []
  let todoCommentCount = 0

  for (const filePath of files) {
    const result = scanFile(filePath, { workspaceRoot, resources, englishKeys })
    for (const key of result.usedKeys) usedKeys.add(key)
    missingKeys.push(...result.missingKeys)
    unknownNamespaces.push(...result.unknownNamespaces)
    dynamicKeyWarnings.push(...result.dynamicKeyWarnings)
    untranslated.push(...result.untranslated)
    todoFindings.push(...result.todoFindings)
    todoCommentCount += result.todoCommentCount
  }

  return {
    workspaceRoot,
    files: files.map((file) => relativePath(workspaceRoot, file)),
    usedKeys: [...usedKeys].sort(),
    missingKeys,
    unknownNamespaces,
    dynamicKeyWarnings,
    untranslated,
    todoFindings,
    todoCommentCount
  }
}

#!/usr/bin/env node

/* oxlint-disable no-console */

const fs = require('node:fs')
const path = require('node:path')
const { randomBytes } = require('node:crypto')

const REPO_ROOT = path.resolve(__dirname, '..')
const TSCONFIG_PATH = path.join(REPO_ROOT, 'tsconfig.node.json')
const OUTPUT_PATH = path.join(REPO_ROOT, 'src/main/ipc/generated-ipc-invoke-map.ts')
const CHECK_MODE = process.argv.includes('--check')

function normalizeGeneratedText(text) {
  return text.replace(/\r\n?/g, '\n')
}

function writeFileAtomically(filePath, content) {
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomBytes(6).toString('hex')}.tmp`
  )
  const fd = fs.openSync(tempPath, 'wx', 0o600)

  try {
    fs.writeFileSync(fd, content, 'utf8')
    fs.closeSync(fd)
    fs.renameSync(tempPath, filePath)
  } catch (error) {
    try {
      fs.closeSync(fd)
    } catch {
      // already closed
    }
    fs.rmSync(tempPath, { force: true })
    throw error
  }
}

function readExistingFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') {
      return ''
    }

    throw error
  }
}

// TypeScript 7 ships no JS compiler API; this generator stays on the last 6.x release.
const ts = require('typescript-6')

function readProgram() {
  const config = ts.readConfigFile(TSCONFIG_PATH, (file) => ts.sys.readFile(file))
  if (config.error) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
  }

  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(TSCONFIG_PATH))
  return ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options
  })
}

function toPosixPath(inputPath) {
  return inputPath.replace(/\\/g, '/')
}

function normalizeImportPath(rawPath) {
  if (!path.isAbsolute(rawPath)) {
    return rawPath
  }

  const relativePath = toPosixPath(path.relative(path.dirname(OUTPUT_PATH), rawPath))
  return relativePath.startsWith('.') ? relativePath : `./${relativePath}`
}

function printTypeNode(typeNode) {
  const source = ts.createSourceFile('tmp.ts', '', ts.ScriptTarget.Latest, false, ts.ScriptKind.TS)
  const file = ts.factory.updateSourceFile(source, [
    ts.factory.createTypeAliasDeclaration(undefined, 'T', undefined, typeNode)
  ])
  return ts
    .createPrinter({ removeComments: true })
    .printNode(ts.EmitHint.Unspecified, typeNode, file)
}

function normalizeTypeText(typeText) {
  return typeText.replace(/import\("([^"]+)"\)/g, (_match, importPath) => {
    return `import("${normalizeImportPath(importPath)}")`
  })
}

function formatType(checker, type) {
  const typeNode = checker.typeToTypeNode(
    type,
    undefined,
    ts.NodeBuilderFlags.NoTruncation | ts.NodeBuilderFlags.UseFullyQualifiedType
  )

  if (!typeNode) {
    return 'unknown'
  }

  return normalizeTypeText(printTypeNode(typeNode))
}

function collectStringLiterals(type) {
  if (type.isUnion()) {
    return type.types.flatMap(collectStringLiterals)
  }
  if (type.isStringLiteral()) {
    return [type.value]
  }
  return []
}

function isMainSourceFile(sourceFile) {
  if (sourceFile.isDeclarationFile) {
    return false
  }

  const filePath = toPosixPath(sourceFile.fileName)
  return filePath.includes('/src/main/') && !filePath.includes('.test.')
}

function isIpcMainHandleCall(node, sourceFile) {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) {
    return false
  }
  if (node.expression.name.text !== 'handle') {
    return false
  }
  return node.expression.expression.getText(sourceFile) === 'ipcMain'
}

function isRegisterCommandCall(node) {
  if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) {
    return false
  }
  return node.expression.text === 'registerCommand'
}

function collectEntries(program) {
  const checker = program.getTypeChecker()
  const entries = new Map()
  const warnings = []

  for (const sourceFile of program.getSourceFiles()) {
    if (!isMainSourceFile(sourceFile)) {
      continue
    }

    function visit(node) {
      const isIpcHandle = isIpcMainHandleCall(node, sourceFile)
      const isRegisterCmd = !isIpcHandle && isRegisterCommandCall(node)

      if (!isIpcHandle && !isRegisterCmd) {
        ts.forEachChild(node, visit)
        return
      }

      const channelArg = node.arguments[0]
      const handlerArg = isIpcHandle ? node.arguments[1] : node.arguments[2]
      const schemaArg = isRegisterCmd ? node.arguments[1] : null
      if (!channelArg || !handlerArg) {
        ts.forEachChild(node, visit)
        return
      }

      const channelType = checker.getTypeAtLocation(channelArg)
      const channels = collectStringLiterals(channelType)

      if (channels.length === 0) {
        warnings.push(
          `Skipping non-literal channel at ${sourceFile.fileName}:${sourceFile.getLineAndCharacterOfPosition(channelArg.getStart()).line + 1}`
        )
        ts.forEachChild(node, visit)
        return
      }

      const handlerType = checker.getTypeAtLocation(handlerArg)
      const signature = checker.getSignaturesOfType(handlerType, ts.SignatureKind.Call)[0]
      if (!signature) {
        warnings.push(
          `Skipping channel without callable handler type at ${sourceFile.fileName}:${sourceFile.getLineAndCharacterOfPosition(handlerArg.getStart()).line + 1}`
        )
        ts.forEachChild(node, visit)
        return
      }

      const skipCount = isIpcHandle ? 1 : 0
      let params
      if (isRegisterCmd && schemaArg) {
        const schemaType = checker.getTypeAtLocation(schemaArg)
        const inputTypeSymbol = schemaType.getProperty('_input') || schemaType.getProperty('_zod')
        let rawInputType
        if (inputTypeSymbol) {
          rawInputType = checker.getTypeOfSymbolAtLocation(inputTypeSymbol, schemaArg)
          if (rawInputType && schemaType.getProperty('_zod')) {
            const zodProp = rawInputType.getProperty('input')
            if (zodProp) {
              rawInputType = checker.getTypeOfSymbolAtLocation(zodProp, schemaArg)
            }
          }
        }
        params = rawInputType
          ? [formatType(checker, rawInputType)]
          : signature
              .getParameters()
              .slice(skipCount)
              .map((symbol) => {
                const symbolType = checker.getTypeOfSymbolAtLocation(symbol, handlerArg)
                return formatType(checker, symbolType)
              })
      } else {
        params = signature
          .getParameters()
          .slice(skipCount)
          .map((symbol) => {
            const symbolType = checker.getTypeOfSymbolAtLocation(symbol, handlerArg)
            return formatType(checker, symbolType)
          })
      }
      const returnType = formatType(checker, checker.getReturnTypeOfSignature(signature))
      const awaitedReturn = isRegisterCmd
        ? `Awaited<${returnType} | { success: false; error: string }>`
        : `Awaited<${returnType}>`
      const argsTuple = params.length > 0 ? `[${params.join(', ')}]` : '[]'

      for (const channel of channels) {
        const existing = entries.get(channel)
        const signatureText = `(...args: ${argsTuple}) => ${awaitedReturn}`
        if (existing && existing !== signatureText) {
          throw new Error(
            `Conflicting handler signatures for channel "${channel}":\n  ${existing}\n  ${signatureText}`
          )
        }
        entries.set(channel, signatureText)
      }

      ts.forEachChild(node, visit)
    }

    visit(sourceFile)
  }

  for (const warning of warnings) {
    console.warn(warning)
  }

  return entries
}

const RESERVED_TYPE_NAMES = new Set([
  'MainIpcInvokeHandlers',
  'MainIpcInvokeChannel',
  'MainIpcInvokeArgs',
  'MainIpcInvokeResult',
  'Awaited',
  'Promise',
  'Parameters',
  'ReturnType'
])

// Replaces inline `import("path").Name` types (banned by lint) with top-level
// `import type` bindings. Returns the rewritten signatures and the import lines.
function hoistTypeImports(signatures) {
  const pathsByName = new Map()
  const pattern = /import\("([^"]+)"\)\.([A-Za-z_$][\w$]*)/g
  for (const signature of signatures) {
    for (const [, importPath, name] of signature.matchAll(pattern)) {
      if (!pathsByName.has(name)) pathsByName.set(name, new Set())
      pathsByName.get(name).add(importPath)
    }
  }

  const aliasFor = new Map()
  const usedAliases = new Set(RESERVED_TYPE_NAMES)
  const keys = []
  for (const name of [...pathsByName.keys()].toSorted((a, b) => a.localeCompare(b))) {
    for (const importPath of [...pathsByName.get(name)].toSorted((a, b) => a.localeCompare(b))) {
      let alias = name
      let suffix = 2
      if (usedAliases.has(alias) || pathsByName.get(name).size > 1) {
        alias = `${name}${suffix++}`
        while (usedAliases.has(alias)) alias = `${name}${suffix++}`
      }
      usedAliases.add(alias)
      aliasFor.set(`${importPath}\0${name}`, alias)
      keys.push({ importPath, name, alias })
    }
  }

  const rewritten = signatures.map((signature) =>
    signature.replace(pattern, (_match, importPath, name) => aliasFor.get(`${importPath}\0${name}`))
  )

  const byPath = new Map()
  for (const { importPath, name, alias } of keys) {
    if (!byPath.has(importPath)) byPath.set(importPath, [])
    byPath.get(importPath).push(alias === name ? name : `${name} as ${alias}`)
  }
  const importLines = [...byPath.keys()]
    .toSorted((a, b) => a.localeCompare(b))
    .map(
      (importPath) => `import type { ${byPath.get(importPath).join(', ')} } from '${importPath}'`
    )

  return { rewritten, importLines }
}

function generateFileContent(entries) {
  const channels = [...entries.keys()].toSorted((a, b) => a.localeCompare(b))
  const { rewritten, importLines } = hoistTypeImports(
    channels.map((channel) => entries.get(channel))
  )
  const lines = [
    '// Auto-generated by scripts/generate-ipc-invoke-map.js. Do not edit manually.',
    '/* oxlint-disable typescript/no-explicit-any */',
    '',
    ...importLines,
    ...(importLines.length > 0 ? [''] : []),
    'export interface MainIpcInvokeHandlers {'
  ]

  channels.forEach((channel, index) => {
    lines.push(`  ${JSON.stringify(channel)}: ${rewritten[index]}`)
  })

  lines.push('}')
  lines.push('')
  lines.push('export type MainIpcInvokeChannel = keyof MainIpcInvokeHandlers')
  lines.push('export type MainIpcInvokeArgs<C extends MainIpcInvokeChannel> =')
  lines.push('  Parameters<MainIpcInvokeHandlers[C]>')
  lines.push('export type MainIpcInvokeResult<C extends MainIpcInvokeChannel> =')
  lines.push('  ReturnType<MainIpcInvokeHandlers[C]>')
  lines.push('')

  return lines.join('\n')
}

function main() {
  const program = readProgram()
  const entries = collectEntries(program)
  const output = generateFileContent(entries)

  const current = readExistingFile(OUTPUT_PATH)

  if (CHECK_MODE) {
    if (normalizeGeneratedText(current) !== normalizeGeneratedText(output)) {
      console.error('IPC invoke map is out of date. Run: node scripts/generate-ipc-invoke-map.js')
      process.exit(1)
    }
    console.log('IPC invoke map is up to date')
    return
  }

  writeFileAtomically(OUTPUT_PATH, output)
  console.log(`Wrote ${path.relative(REPO_ROOT, OUTPUT_PATH)}`)
}

main()

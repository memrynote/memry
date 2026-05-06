#!/usr/bin/env node

/* eslint-disable no-console */

const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')

const REPO_ROOT = path.resolve(__dirname, '..')
const TSCONFIG_PATH = path.join(REPO_ROOT, 'tsconfig.node.json')
const OUTPUT_PATH = path.join(REPO_ROOT, 'src/main/ipc/generated-ipc-invoke-map.ts')
const CHECK_MODE = process.argv.includes('--check')
const WORKSPACE_ROOT = path.resolve(REPO_ROOT, '../..')
const workspaceRequire = createRequire(path.join(WORKSPACE_ROOT, 'package.json'))

function loadTypeScript() {
  try {
    return workspaceRequire('typescript')
  } catch (error) {
    const pnpmStoreDir = path.join(WORKSPACE_ROOT, 'node_modules/.pnpm')
    const packageDir = fs
      .readdirSync(pnpmStoreDir, { withFileTypes: true })
      .find((entry) => entry.isDirectory() && entry.name.startsWith('typescript@'))

    if (!packageDir) {
      throw error
    }

    return require(path.join(pnpmStoreDir, packageDir.name, 'node_modules/typescript'))
  }
}

const ts = loadTypeScript()

function readProgram() {
  const config = ts.readConfigFile(TSCONFIG_PATH, ts.sys.readFile)
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

function generateFileContent(entries) {
  const channels = [...entries.keys()].sort((a, b) => a.localeCompare(b))
  const lines = [
    '// Auto-generated by scripts/generate-ipc-invoke-map.js. Do not edit manually.',
    '/* eslint-disable @typescript-eslint/no-explicit-any */',
    '',
    'export interface MainIpcInvokeHandlers {'
  ]

  for (const channel of channels) {
    lines.push(`  ${JSON.stringify(channel)}: ${entries.get(channel)}`)
  }

  lines.push('}')
  lines.push('')
  lines.push('export type MainIpcInvokeChannel = keyof MainIpcInvokeHandlers')
  lines.push('export type MainIpcInvokeArgs<C extends MainIpcInvokeChannel> =')
  lines.push('  Parameters<MainIpcInvokeHandlers[C]>')
  lines.push('export type MainIpcInvokeResult<C extends MainIpcInvokeChannel> =')
  lines.push('  ReturnType<MainIpcInvokeHandlers[C]>')
  lines.push('')

  return `${lines.join('\n')}`
}

function main() {
  const program = readProgram()
  const entries = collectEntries(program)
  const output = generateFileContent(entries)

  const current = fs.existsSync(OUTPUT_PATH) ? fs.readFileSync(OUTPUT_PATH, 'utf8') : ''

  if (CHECK_MODE) {
    if (current !== output) {
      console.error('IPC invoke map is out of date. Run: node scripts/generate-ipc-invoke-map.js')
      process.exit(1)
    }
    console.log('IPC invoke map is up to date')
    return
  }

  fs.writeFileSync(OUTPUT_PATH, output, 'utf8')
  console.log(`Wrote ${path.relative(REPO_ROOT, OUTPUT_PATH)}`)
}

main()

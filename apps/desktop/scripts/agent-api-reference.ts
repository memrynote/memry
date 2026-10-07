/**
 * Builds the agent API reference from the schemas the app validates with: the
 * named MCP tools' zod inputs (`TOOL_SCHEMAS`) and the desktop API operations'
 * argument schemas (`@memry/contracts/agent-desktop-api-args`). It writes a page
 * for docs.memrynote.com and a JSON Schema file next to it, both stamped with
 * the app version. The examples come from agent-api-examples.json, which
 * scripts/agent-api-capture.mjs fills by calling a running app.
 *
 *   pnpm --filter @memry/desktop agent-api:generate                       # keep the stamp, mark it +main
 *   pnpm --filter @memry/desktop agent-api:generate --app-version 2026.1010.1
 *   pnpm --filter @memry/desktop agent-api:generate --check               # fail when the files are stale
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { format, resolveConfig } from 'prettier'
import { z } from 'zod'

import { AgentMcpDesktopOperations } from '@memry/contracts/agent-mcp-channels'
import type { AgentMcpDesktopOperation } from '@memry/contracts/agent-mcp-channels'

import { describeDesktopOperation } from '../src/main/agent/mcp/tools/desktop-api-describe'
import type { DesktopOperationDescription } from '../src/main/agent/mcp/tools/desktop-api-describe'
import { renderType } from '../src/main/agent/mcp/tools/desktop-api-issues'
import {
  READ_TOOL_NAMES,
  TOOL_SCHEMAS,
  WRITE_TOOL_NAMES,
  type ToolName
} from '../src/main/agent/mcp/tools/schemas'

type JsonNode = Record<string, unknown>

export interface ToolExample {
  arguments: JsonNode
  reply?: unknown
  is_error?: boolean
  not_run?: string
}

export interface OperationExample {
  args: unknown[]
  reply?: unknown
  is_error?: boolean
  not_run?: string
}

export interface AgentApiExamples {
  tools: Record<string, ToolExample>
  operations: Record<string, OperationExample>
}

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../../..')

export const REFERENCE_PATHS = {
  examples: path.join(here, 'agent-api-examples.json'),
  page: path.join(repoRoot, 'apps/docs/src/user-guide/ai/agent-api-reference.md'),
  schema: path.join(repoRoot, 'apps/docs/src/public/agent-api/memry-agent-api.schema.json')
}

export const SCHEMA_URL = 'https://docs.memrynote.com/agent-api/memry-agent-api.schema.json'
const PAGE_URL = 'https://docs.memrynote.com/user-guide/ai/agent-api-reference'

const WRITE_TOOLS = new Set<string>(WRITE_TOOL_NAMES)

function toolInputSchema(name: ToolName): JsonNode {
  const { $schema: _drop, ...schema } = z.toJSONSchema(TOOL_SCHEMAS[name].input, {
    io: 'input',
    unrepresentable: 'any'
  }) as JsonNode
  return schema
}

function operationArgsSchema(description: DesktopOperationDescription): JsonNode {
  const { $schema: _drop, ...schema } = description.args_schema
  return schema
}

function describeOperation(operation: AgentMcpDesktopOperation): DesktopOperationDescription {
  return describeDesktopOperation(operation) as DesktopOperationDescription
}

// ---------------------------------------------------------------------------
// JSON Schema file
// ---------------------------------------------------------------------------

export function buildSchemaFile(appVersion: string, examples: AgentApiExamples): JsonNode {
  const defs: Record<string, JsonNode> = {}
  for (const name of [...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES]) {
    const example = examples.tools[name]
    defs[name] = {
      ...toolInputSchema(name),
      'x-memry-kind': 'tool',
      'x-memry-description': TOOL_SCHEMAS[name].description,
      'x-memry-requires-approval': WRITE_TOOLS.has(name),
      ...(example ? { 'x-memry-example': example } : {})
    }
  }
  for (const operation of AgentMcpDesktopOperations) {
    const description = describeOperation(operation)
    const example = examples.operations[operation]
    defs[operation] = {
      ...operationArgsSchema(description),
      'x-memry-kind': 'desktop-operation',
      'x-memry-summary': description.summary,
      'x-memry-tool': description.tool,
      'x-memry-call': description.call,
      'x-memry-params': description.params,
      'x-memry-requires-approval': description.requires_approval,
      ...(example ? { 'x-memry-example': example } : {})
    }
  }
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: SCHEMA_URL,
    title: 'Memry agent API',
    description:
      'The arguments of every Memry MCP tool and every desktop API operation, for agents. ' +
      'Each $defs entry named vault_* is the `arguments` object of that tools/call. Each other ' +
      'entry is the `args` array that vault_desktop_read or vault_desktop_write (x-memry-tool) ' +
      `takes for that operation. Human-readable page: ${PAGE_URL}`,
    'x-memry-app-version': appVersion,
    'x-memry-endpoint': 'http://127.0.0.1:<port>/mcp',
    $defs: defs
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

interface ParamRow {
  name: string
  type: string
  required: boolean
  values: string
  description: string
}

const ROW_MAX_DEPTH = 3

function constraintsOf(node: JsonNode): string[] {
  const out: string[] = []
  const keys: Array<[string, string]> = [
    ['minLength', 'min length'],
    ['maxLength', 'max length'],
    ['minimum', 'min'],
    ['maximum', 'max'],
    ['exclusiveMinimum', 'greater than'],
    ['exclusiveMaximum', 'less than'],
    ['minItems', 'min items'],
    ['maxItems', 'max items'],
    ['format', 'format'],
    ['pattern', 'pattern']
  ]
  for (const [key, label] of keys) {
    if (node[key] !== undefined) out.push(`${label} ${code(String(node[key]))}`)
  }
  return out
}

function literalsOf(node: JsonNode): unknown[] | null {
  if (Array.isArray(node.enum)) return node.enum
  if ('const' in node) return [node.const]
  return null
}

/** The object members of a node: itself, or the object branches of its union. */
function objectBranch(node: JsonNode): JsonNode | null {
  if (node.type === 'object' && node.properties) return node
  const options = (node.anyOf ?? node.oneOf) as JsonNode[] | undefined
  if (!options) return null
  const objects = options.filter((option) => option.type === 'object' && option.properties)
  const rest = options.filter((option) => !(option.type === 'object' && option.properties))
  return objects.length === 1 && rest.every((option) => option.type === 'null') ? objects[0] : null
}

function resolve(node: JsonNode, root: JsonNode): JsonNode {
  if (typeof node.$ref !== 'string') return node
  const name = node.$ref.replace(/^#\/\$defs\//, '')
  return ((root.$defs as Record<string, JsonNode> | undefined)?.[name] ?? node) as JsonNode
}

function rowsFor(
  name: string,
  node: JsonNode,
  required: boolean,
  root: JsonNode,
  depth: number,
  rows: ParamRow[]
): void {
  const resolved = resolve(node, root)
  const literals = literalsOf(resolved)
  const values: string[] = []
  if (literals && literals.length > 0) {
    values.push(literals.map((value) => code(JSON.stringify(value))).join(', '))
  } else {
    const options = (resolved.anyOf ?? resolved.oneOf) as JsonNode[] | undefined
    const optionLiterals = options?.flatMap((option) => literalsOf(option) ?? [])
    if (optionLiterals && optionLiterals.length > 0) {
      values.push(optionLiterals.map((value) => code(JSON.stringify(value))).join(', '))
    }
  }
  values.push(...constraintsOf(resolved))
  if (resolved.default !== undefined)
    values.push(`default ${code(JSON.stringify(resolved.default))}`)

  const branch = depth < ROW_MAX_DEPTH ? objectBranch(resolved) : null
  const arrayItems =
    depth < ROW_MAX_DEPTH && resolved.type === 'array' && resolved.items
      ? objectBranch(resolve(resolved.items as JsonNode, root))
      : null
  rows.push({
    name,
    type: branch
      ? resolved === branch
        ? 'object'
        : 'object | null'
      : arrayItems
        ? 'object[]'
        : renderType(resolved, root),
    required,
    values: values.join('; '),
    description: typeof resolved.description === 'string' ? resolved.description : ''
  })
  const nested = branch ?? arrayItems
  if (!nested) return
  const prefix = arrayItems ? `${name}[]` : name
  const nestedRequired = new Set((nested.required as string[] | undefined) ?? [])
  for (const [key, child] of Object.entries(nested.properties as Record<string, JsonNode>)) {
    rowsFor(`${prefix}.${key}`, child, nestedRequired.has(key), root, depth + 1, rows)
  }
}

function toolRows(schema: JsonNode): ParamRow[] {
  const rows: ParamRow[] = []
  const required = new Set((schema.required as string[] | undefined) ?? [])
  for (const [key, child] of Object.entries(
    (schema.properties as Record<string, JsonNode>) ?? {}
  )) {
    rowsFor(key, child, required.has(key), schema, 0, rows)
  }
  return rows
}

function operationRows(description: DesktopOperationDescription, schema: JsonNode): ParamRow[] {
  const rows: ParamRow[] = []
  const items = (schema.prefixItems as JsonNode[] | undefined) ?? []
  description.params.forEach((param, index) => {
    rowsFor(param.name, items[index] ?? {}, param.required, schema, 0, rows)
  })
  return rows
}

function code(text: string): string {
  const safe = text.replaceAll('|', '\\|')
  return safe.includes('`') ? `\`\` ${safe} \`\`` : `\`${safe}\``
}

/** Prose from a tool description: keep Vue and HTML from reading it as markup. */
function prose(text: string): string {
  return text.replaceAll('<', '&lt;').replaceAll('{{', '{&#123;').replaceAll('|', '\\|')
}

function table(rows: ParamRow[]): string {
  if (rows.length === 0) return 'Takes no arguments.\n'
  const notes = rows.some((row) => row.description)
  const lines = [
    `| Argument | Type | Required | Allowed values |${notes ? ' Notes |' : ''}`,
    `| --- | --- | --- | --- |${notes ? ' --- |' : ''}`,
    ...rows.map(
      (row) =>
        `| ${code(row.name)} | ${code(row.type)} | ${row.required ? 'yes' : 'no'} | ${row.values} |` +
        (notes ? ` ${prose(row.description)} |` : '')
    )
  ]
  return `${lines.join('\n')}\n`
}

function jsonBlock(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`
}

function exampleSection(
  call: unknown,
  example: { reply?: unknown; is_error?: boolean; not_run?: string } | undefined
): string {
  if (!example) return ''
  const parts = ['Example call:\n', jsonBlock(call)]
  if (example.not_run) {
    parts.push(`\nNo example reply: ${prose(example.not_run)}\n`)
  } else {
    parts.push(`\nReply${example.is_error ? ' (an error)' : ''}:\n`, jsonBlock(example.reply))
  }
  return parts.join('')
}

const DOMAIN_TITLES: Record<string, string> = {
  notes: 'Notes',
  tasks: 'Tasks and projects',
  inbox: 'Inbox',
  journal: 'Journal',
  properties: 'Properties',
  templates: 'Templates',
  savedFilters: 'Saved filters',
  bookmarks: 'Bookmarks',
  tags: 'Tags',
  folderView: 'Folder views',
  reminders: 'Reminders',
  calendar: 'Calendar',
  settings: 'Settings',
  search: 'Search',
  graph: 'Graph',
  homePages: 'Home pages',
  vault: 'Vault',
  canvas: 'Canvas'
}

const desktopIntro = `## Desktop API operations

${code('vault_desktop_read')} runs a read operation and ${code('vault_desktop_write')} a write
operation, as ${code('{ "operation": "notes.list", "args": [ ... ] }')}. ${code('args')} holds the
operation's arguments in call order; an optional argument at the end can be left out. Each
operation below names its tool and its call shape, where ${code('?')} marks an optional argument,
then lists the arguments by name. A name like ${code('input.title')} is the key ${code('title')}
inside the argument ${code('input')}. ${code('vault_desktop_describe')} returns the same for one
operation at run time.
`

export function buildPage(appVersion: string, examples: AgentApiExamples): string {
  const out: string[] = []
  out.push(`---
outline: [2, 3]
---

# Agent API reference

<!-- Generated by apps/desktop/scripts/agent-api-reference.ts. Do not edit by hand. -->

This page lists every tool Memry's MCP server offers and every desktop API operation those tools
reach, with each argument's type, whether it is required, the values it takes, and an example call
with the reply a running Memry gave. It is written for agents and the people who set them up, so an
agent never has to read the app's own files to find out how to call it.

**Describes Memry ${code(appVersion)}.** A version ending in ${code('+main')} means the reference
was regenerated from the source after that release, and the next release ships it. The reference
is generated from the schemas Memry checks every call against, the same schemas behind
${code('vault_desktop_describe')} and the ${code('VALIDATION')} errors, and is regenerated for each release.

The same content as JSON Schema (draft 2020-12), for an agent to fetch:
[${SCHEMA_URL}](/agent-api/memry-agent-api.schema.json). Its ${code('$defs')} hold one entry per
tool (the ${code('arguments')} object) and one per desktop operation (the ${code('args')} array), each
with its description, whether it needs approval, and the example below.

## Calling a tool

Memry serves MCP over HTTP at ${code('http://127.0.0.1:<port>/mcp')}, with the bearer token from
Settings -> AI Assistant -> Agent MCP. See [Agent Chat & MCP Server](./agent-mcp#connection) for
the connection, and for which clients may write. A tool call is a JSON-RPC ${code('tools/call')}
request:

\`\`\`json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": { "name": "vault_search_notes", "arguments": { "query": "budget", "limit": 5 } }
}
\`\`\`

The reply's ${code('result.content[0].text')} is the JSON shown as the reply in each example below.
A refused call sets ${code('result.isError')} and its text is ${code('{ code, message, details }')}.
Example ids, dates and times come from a test vault; arrays in a reply are cut to their first
three entries and long strings are shortened, marked ${code('…')}.

Write tools pause for the owner's approval unless the owner set confirmations to **Always allow**,
and only a turn Memry itself runs can write. A call whose arguments do not match the schema is
refused with ${code('VALIDATION')} before any approval, and nothing runs. Every tool refuses an
argument it does not take.
`)

  out.push('\n## Named tools\n')
  for (const [heading, names] of [
    ['Read tools', READ_TOOL_NAMES],
    ['Write tools', WRITE_TOOL_NAMES]
  ] as const) {
    out.push(`\n### ${heading}\n`)
    for (const name of names) {
      const example = examples.tools[name]
      out.push(`\n#### ${name}\n\n`)
      out.push(`${prose(TOOL_SCHEMAS[name].description)}\n\n`)
      out.push(`${WRITE_TOOLS.has(name) ? 'Write tool; needs approval.' : 'Read tool.'}\n\n`)
      out.push(table(toolRows(toolInputSchema(name))))
      out.push('\n')
      out.push(exampleSection(example?.arguments ?? {}, example))
    }
  }

  out.push(`\n${desktopIntro}`)
  let domain = ''
  for (const operation of AgentMcpDesktopOperations) {
    const [area] = operation.split('.')
    if (area !== domain) {
      domain = area
      out.push(`\n### ${DOMAIN_TITLES[area] ?? area}\n`)
    }
    const description = describeOperation(operation)
    const example = examples.operations[operation]
    out.push(`\n#### ${operation}\n\n`)
    out.push(`${prose(description.summary)}\n\n`)
    out.push(
      `${code(description.call)} through ${code(description.tool)}` +
        `${description.requires_approval ? '; needs approval' : ''}.\n\n`
    )
    out.push(table(operationRows(description, operationArgsSchema(description))))
    out.push('\n')
    out.push(
      exampleSection(
        { name: description.tool, arguments: { operation, args: example?.args ?? [] } },
        example
      )
    )
  }
  return `${out
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function readExamples(): AgentApiExamples {
  return JSON.parse(readFileSync(REFERENCE_PATHS.examples, 'utf8')) as AgentApiExamples
}

export function committedAppVersion(): string | null {
  try {
    const schema = JSON.parse(readFileSync(REFERENCE_PATHS.schema, 'utf8')) as JsonNode
    const version = schema['x-memry-app-version']
    return typeof version === 'string' ? version : null
  } catch {
    return null
  }
}

/** A regeneration between releases keeps the last release's version and marks it +main. */
export function nextAppVersion(explicit: string | undefined, committed: string | null): string {
  if (explicit) return explicit
  if (!committed) throw new Error('No committed reference yet: pass --app-version <version>.')
  return committed.endsWith('+main') ? committed : `${committed}+main`
}

/** lint-staged runs prettier on both files, so the generator writes what prettier would. */
async function formatLikeCommit(file: string, content: string): Promise<string> {
  const options = await resolveConfig(file)
  return format(content, { ...options, filepath: file })
}

export async function renderReference(appVersion: string, examples = readExamples()) {
  return {
    page: await formatLikeCommit(REFERENCE_PATHS.page, buildPage(appVersion, examples)),
    schema: await formatLikeCommit(
      REFERENCE_PATHS.schema,
      JSON.stringify(buildSchemaFile(appVersion, examples), null, 2)
    )
  }
}

async function main(argv: string[]): Promise<void> {
  const check = argv.includes('--check')
  const flag = argv.indexOf('--app-version')
  const explicit = flag >= 0 ? argv[flag + 1] : undefined
  if (flag >= 0 && !explicit) throw new Error('--app-version needs a value')
  const committed = committedAppVersion()
  const version = check ? (committed ?? '') : nextAppVersion(explicit, committed)
  const { page, schema } = await renderReference(version)
  if (check) {
    const stale = [
      [REFERENCE_PATHS.page, page],
      [REFERENCE_PATHS.schema, schema]
    ].filter(([file, content]) => {
      try {
        return readFileSync(file, 'utf8') !== content
      } catch {
        return true
      }
    })
    if (stale.length > 0) {
      throw new Error(
        `Stale agent API reference: ${stale.map(([file]) => path.relative(repoRoot, file)).join(', ')}. ` +
          'Run pnpm --filter @memry/desktop agent-api:generate.'
      )
    }
    return
  }
  writeFileSync(REFERENCE_PATHS.page, page)
  writeFileSync(REFERENCE_PATHS.schema, schema)
  console.log(`Agent API reference for ${version} written.`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
}
